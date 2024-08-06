require("dotenv").config({
  path: "./.env",
});

import bodyParser from "body-parser";
import express, { NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import { proxyRouter } from "./controllers/public/proxyController";
import {
  DLQ_WORKER_COUNT,
  NORMAL_WORKER_COUNT,
} from "./lib/clients/kafkaConsumers/constant";
import { tokenRouter } from "./lib/routers/tokenRouter";
import { runLoopsOnce, runMainLoops } from "./mainLoops";
import { authMiddleware } from "./middleware/auth";
import { IS_RATE_LIMIT_ENABLED, limiter } from "./middleware/ratelimitter";
import { RegisterRoutes as registerPrivateTSOARoutes } from "./tsoa-build/private/routes";
import { RegisterRoutes as registerPublicTSOARoutes } from "./tsoa-build/public/routes";
import * as publicSwaggerDoc from "./tsoa-build/public/swagger.json";
import { initLogs } from "./utils/injectLogs";
import { initSentry } from "./utils/injectSentry";
import { startConsumers } from "./workers/consumerInterface";
import { unauthorizedCacheMiddleware } from "./middleware/unauthorizedCache";
import { postHogClient } from "./lib/clients/postHogClient";
import { uuid } from "uuidv4";

export const ENVIRONMENT: "production" | "development" = (process.env
  .VERCEL_ENV ?? "development") as any;

if (ENVIRONMENT === "production" || process.env.ENABLE_CRON_JOB === "true") {
  runMainLoops();
}
const allowedOriginsEnv = {
  production: [
    /^https?:\/\/(www\.)?helicone\.ai$/,
    /^https?:\/\/(www\.)?.*-helicone\.vercel\.app$/,
    /^https?:\/\/(www\.)?helicone\.vercel\.app$/,
    /^https?:\/\/(www\.)?helicone-git-valhalla-use-jawn-to-read-helicone\.vercel\.app$/,
    /^http:\/\/localhost:3000$/,
    /^http:\/\/localhost:3001$/,
    /^https?:\/\/(www\.)?eu\.helicone\.ai$/, // Added eu.helicone.ai
    /^https?:\/\/(www\.)?us\.helicone\.ai$/,
  ],
  development: [/^http:\/\/localhost:3000$/, /^http:\/\/localhost:3001$/],
  preview: [/^http:\/\/localhost:3000$/, /^http:\/\/localhost:3001$/],
};

const allowedOrigins = allowedOriginsEnv[ENVIRONMENT];

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(
  bodyParser.urlencoded({
    limit: "50mb",
    extended: true,
    parameterLimit: 50000,
  })
);

const KAFKA_CREDS = JSON.parse(process.env.KAFKA_CREDS ?? "{}");
const KAFKA_ENABLED = (KAFKA_CREDS?.KAFKA_ENABLED ?? "false") === "true";

if (KAFKA_ENABLED) {
  startConsumers({
    dlqCount: 0,
    normalCount: 0,
  });
}

app.use((req, res, next) => {
  const start = Date.now();

  const captureRequest = () => {
    const duration = Date.now() - start;
    try {
      postHogClient?.capture({
        distinctId: uuid(),
        event: "jawn_http_request",
        properties: {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration: duration,
          userAgent: req.headers["user-agent"],
        },
      });
    } catch (error) {
      console.error("Failed to capture request in PostHog:", error);
    }
  };

  res.on("finish", captureRequest);

  next();
});

app.get("/healthcheck", (req, res) => {
  res.json({
    status: "healthy :)",
  });
});

if (ENVIRONMENT !== "production") {
  app.get("/run-loops/:index", async (req, res) => {
    const index = parseInt(req.params.index);
    await runLoopsOnce(index);
    res.json({
      status: "done",
    });
  });
}

initSentry(app);
initLogs(app);

app.options("*", (req, res) => {
  if (
    req.headers.origin &&
    allowedOrigins.some((allowedOrigin) =>
      allowedOrigin.test(req.headers.origin ?? "")
    )
  ) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "");
  }
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Helicone-Authorization"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.status(200).send();
});

const v1APIRouter = express.Router();
const unAuthenticatedRouter = express.Router();
const v1ProxyRouter = express.Router();

v1ProxyRouter.use(proxyRouter);
app.use(v1ProxyRouter);

unAuthenticatedRouter.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(publicSwaggerDoc as any)
);

unAuthenticatedRouter.use(tokenRouter);

unAuthenticatedRouter.use("/download/swagger.json", (req, res) => {
  res.json(publicSwaggerDoc as any);
});

// v1APIRouter.use(
//   "/v1/public/dataisbeautiful",
//   unauthorizedCacheMiddleware("/v1/public/dataisbeautiful")
// );

v1APIRouter.use(authMiddleware);

// Create and use the rate limiter
if (IS_RATE_LIMIT_ENABLED) {
  v1APIRouter.use(limiter);
}

v1APIRouter.use(bodyParser.json({ limit: "50mb" }));
v1APIRouter.use(
  bodyParser.urlencoded({
    limit: "50mb",
    extended: true,
    parameterLimit: 50000,
  })
);
registerPublicTSOARoutes(v1APIRouter);
registerPrivateTSOARoutes(v1APIRouter);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    return next();
  }
  if (allowedOrigins.some((allowedOrigin) => allowedOrigin.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PATCH, PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Helicone-Authorization"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

app.use(unAuthenticatedRouter);
app.use(v1APIRouter);

function setRouteTimeout(
  req: express.Request,
  res: express.Response,
  next: NextFunction
) {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).send("Request timed out");
    }
  }, 10000); // 10 seconds

  res.on("finish", () => clearTimeout(timeout));
  next();
}

app.use(setRouteTimeout);

const server = app.listen(
  parseInt(process.env.PORT ?? "8585"),
  "0.0.0.0",
  () => {
    console.log(`Server is running on http://localhost:8585`);
  }
);

server.on("error", console.error);

// Thisp
server.setTimeout(1000 * 60 * 10); // 10 minutes
