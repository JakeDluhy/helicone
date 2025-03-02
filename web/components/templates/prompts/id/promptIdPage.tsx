import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrompt, usePromptVersions } from "@/services/hooks/prompts/prompts";
import { useJawnClient } from "@/lib/clients/jawnHook";
import useNotification from "@/components/shared/notification/useNotification";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import LoadingAnimation from "@/components/shared/loadingAnimation";
import ResizablePanels from "@/components/shared/universal/ResizablePanels";
import MessagesPanel from "@/components/shared/prompts/MessagesPanel";
import { PromptState, StateMessage, Variable } from "@/types/prompt-state";
import {
  extractVariables,
  isValidVariableName,
  deduplicateVariables,
} from "@/utils/variables";
import {
  isLastMessageUser,
  heliconeToStateMessages,
  removeMessagePair,
} from "@/utils/messages";
import { isPrefillSupported } from "@/utils/messages";
import PromptMetricsTab from "./PromptMetricsTab";
import ResponsePanel from "@/components/shared/prompts/ResponsePanel";
import ParametersPanel from "@/components/shared/prompts/ParametersPanel";
import { PiCommandBold, PiRocketLaunchBold } from "react-icons/pi";
import { generateStream } from "@/lib/api/llm/generate-stream";
import { readStream } from "@/lib/api/llm/read-stream";
import { toKebabCase } from "@/utils/strings";
import Link from "next/link";
import GlassHeader from "@/components/shared/universal/GlassHeader";
import ActionButton from "@/components/shared/universal/ActionButton";
import VersionSelector from "@/components/shared/universal/VersionSelector";
import { MdKeyboardReturn } from "react-icons/md";
import {
  PiSpinnerGapBold,
  PiStopBold,
  PiPlayBold,
  PiCaretLeftBold,
} from "react-icons/pi";
import VariablesPanel from "@/components/shared/prompts/VariablesPanel";
import { FlaskConicalIcon } from "lucide-react";
import { useRouter } from "next/router";
import { useExperiment } from "./hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DiffHighlight } from "../../welcome/diffHighlight";
import { autoFillInputs } from "@helicone/prompts";

interface PromptIdPageProps {
  id: string;
  currentPage: number;
  pageSize: number;
}

export default function PromptIdPage(props: PromptIdPageProps) {
  // PARAMS
  const { id, currentPage, pageSize } = props;

  // STATE
  const [state, setState] = useState<PromptState | null>(null);

  // STREAMING
  const [isStreaming, setIsStreaming] = useState(false);
  const abortController = useRef<AbortController | null>(null);

  // HOOKS
  // - Router
  const router = useRouter();
  // - Jawn Client
  const jawnClient = useJawnClient();
  // - Prompt Table
  const {
    prompt,
    isLoading: isPromptLoading,
    refetch: refetchPrompt,
  } = usePrompt(id);
  // - Prompt Versions Table
  const {
    prompts: promptVersions,
    isLoading: isVersionsLoading,
    refetch: refetchPromptVersions,
  } = usePromptVersions(id);
  // - Notifications
  const { setNotification } = useNotification();
  // - Experiment
  const { newFromPromptVersion } = useExperiment();

  // VALIDATION
  // - Can Run
  const canRun = useMemo(
    () =>
      (state?.messages.some(
        (m) =>
          typeof m !== "string" &&
          m.role === "user" &&
          (typeof m.content === "string" ? m.content.trim().length > 0 : true)
      ) ??
        false) &&
      prompt?.metadata?.createdFromUi !== false,
    [state?.messages, prompt?.metadata?.createdFromUi]
  );

  // CALLBACKS
  // - Load Version Data into State
  const loadVersionData = useCallback(
    (ver: any) => {
      if (!ver) return;
      // 1. Parse the helicone template and metadata columns from the version
      const templateData =
        typeof ver.helicone_template === "string"
          ? JSON.parse(ver.helicone_template)
          : ver.helicone_template;

      const metadata =
        typeof ver.metadata === "string"
          ? JSON.parse(ver.metadata)
          : (ver.metadata as {
              provider?: string;
              isProduction?: boolean;
              inputs?: Record<string, string>;
            });

      // 2. Derive "masterVersion" if needed
      const masterVersion =
        metadata.isProduction === true
          ? ver.major_version
          : promptVersions?.find(
              (v) => (v.metadata as { isProduction?: boolean })?.isProduction
            )?.major_version ?? ver.major_version;

      // 3. Convert any messages in the template to StateMessages
      const stateMessages = heliconeToStateMessages(templateData.messages);

      // 4.A. First collect all variables and their default values from the metadata inputs
      let variables: Variable[] = Object.entries(metadata.inputs || {}).map(
        ([name, value]) => ({
          name,
          value: value as string,
          isValid: isValidVariableName(name),
          isMessage: false,
        })
      );
      // 4.B. Extract additional variables contained in message content
      stateMessages.forEach((msg) => {
        const vars = extractVariables(msg.content, "helicone");
        vars.forEach((v) => {
          variables.push({
            name: v.name,
            value: metadata.inputs?.[v.name] ?? v.value ?? "",
            isValid: v.isValid ?? true,
            isMessage: msg.idx !== undefined,
          });
        });
      });
      // 4.C. Add message variables to the list
      stateMessages.forEach((msg) => {
        msg.idx !== undefined &&
          variables.push({
            name: `message_${msg.idx}`,
            value: "",
            isValid: true,
            isMessage: true,
          });
      });

      // 4.D. Deduplicate variables
      variables = deduplicateVariables(variables);

      // 6. Update state with the processed data
      setState({
        promptId: id,
        masterVersion: masterVersion,
        version: ver.major_version,
        versionId: ver.id,
        messages: stateMessages,
        parameters: {
          provider: metadata.provider ?? "openai",
          model: templateData.model ?? "gpt-4o-mini",
          temperature: templateData.temperature ?? 0.7,
        },
        variables: variables,
        evals: templateData.evals || [],
        structure: templateData.structure,
        isDirty: false,
      });
    },
    [id, promptVersions]
  );
  // - Update State
  const updateState = useCallback(
    (
      updates:
        | Partial<PromptState>
        | ((prev: PromptState | null) => Partial<PromptState>),
      markDirty: boolean = true
    ) => {
      setState((prev) => {
        if (!prev) return null;
        const newUpdates =
          typeof updates === "function" ? updates(prev) : updates;
        return {
          ...prev,
          ...newUpdates,
          isDirty: markDirty ? true : prev.isDirty,
        };
      });
    },
    []
  );
  // - Message Change
  const handleMessageChange = useCallback(
    (index: number, content: string) => {
      updateState((prev) => {
        if (!prev) return {};

        // Replace the message content at the changed index
        const updatedMessages = prev.messages.map((msg, i) => {
          if (i !== index) return msg;
          return { ...msg, content };
        });

        // Extract variables from all updatedMessages, preserving existing variable data, and deduplicating
        const existingVariables = prev.variables || [];
        console.log("Existing variables:", existingVariables);

        const extractedVars = updatedMessages.flatMap((msg) => {
          const vars = extractVariables(msg.content, "helicone");
          console.log("Extracted vars from message:", msg.content, vars);
          return vars;
        });
        console.log("All extracted vars:", extractedVars);

        const updatedVariables = deduplicateVariables(
          extractedVars.map((newVar) => {
            const existingVar = existingVariables.find(
              (v) => v.name === newVar.name
            );
            console.log(
              "Processing var:",
              newVar.name,
              "existing:",
              existingVar,
              "new:",
              newVar
            );
            return existingVar || newVar;
          })
        );
        console.log("Final updated variables:", updatedVariables);

        return {
          messages: updatedMessages,
          variables: updatedVariables,
        };
      });
    },
    [updateState]
  );
  // - Remove Message
  const handleRemoveMessage = useCallback(
    (index: number) => {
      updateState({
        messages: removeMessagePair(state!.messages, index),
      });
    },
    [state, updateState]
  );
  // - Create Variable
  const handleVariableCreate = useCallback(
    (newVariable: Variable) => {
      updateState((prev) => {
        if (!prev) return {};
        const currentVars = [...(prev.variables || [])];
        const existingIndex = currentVars.findIndex(
          (v) => v.name === newVariable.name
        );

        if (existingIndex >= 0) {
          currentVars[existingIndex] = {
            ...currentVars[existingIndex],
            ...newVariable,
          };
        } else {
          currentVars.push(newVariable);
        }

        return { variables: currentVars };
      });
    },
    [updateState]
  );
  // - Change Variable
  const handleVariableChange = useCallback(
    (index: number, value: string) => {
      updateState((prev) => {
        if (!prev?.variables) return {};

        // TODO: Make variables carry an optional idx instead of isMessage, so all of this can be cleaned up with (index: number, value: string, idx?: number)
        // TODO: This will also allow me to clean up the populateVariables helper function from VariablesPanel
        const updatedVariables = [...prev.variables];
        const variable = updatedVariables[index];
        updatedVariables[index] = { ...variable, value };

        // If this is a message variable, also update the corresponding message
        const messageMatch = variable.name.match(/^message_(\d+)$/);
        if (messageMatch) {
          const messageIdx = parseInt(messageMatch[1]);
          let parsedValue: StateMessage;
          try {
            parsedValue = JSON.parse(value);
          } catch (e) {
            return { variables: updatedVariables };
          }

          const updatedMessages = prev.messages.map((msg) => {
            if (msg.idx === messageIdx) {
              return {
                ...msg,
                role: parsedValue.role,
                content: parsedValue.content,
              };
            }
            return msg;
          });

          return {
            variables: updatedVariables,
            messages: updatedMessages,
          };
        }

        return { variables: updatedVariables };
      });
    },
    [updateState]
  );
  // - Promote Version
  const handleVersionPromote = useCallback(
    async (version: any) => {
      if (!version) return;

      const currentProductionVersion = promptVersions?.find(
        (v) => (v.metadata as { isProduction?: boolean })?.isProduction
      );

      try {
        const result = await jawnClient.POST(
          "/v1/prompt/version/{promptVersionId}/promote",
          {
            params: {
              path: {
                promptVersionId: version.id,
              },
            },
            body: {
              previousProductionVersionId:
                currentProductionVersion?.id ?? version.id,
            },
          }
        );

        if (result.error) {
          setNotification("Failed to promote version", "error");
          return;
        }

        await refetchPromptVersions();
        // Update state to reflect the new master version
        setState((prev) =>
          prev
            ? {
                ...prev,
                masterVersion: version.major_version,
              }
            : null
        );
        setNotification(
          `Promoted version ${version.major_version} to production.`,
          "success"
        );
      } catch (error) {
        console.error("Error promoting version:", error);
        setNotification("Failed to promote version", "error");
      }
    },
    [jawnClient, promptVersions, refetchPromptVersions, setNotification]
  );
  // - Handle ID Edit
  const handleIdEdit = useCallback(
    async (newId: string) => {
      const kebabId = toKebabCase(newId);
      if (kebabId !== id) {
        const result = await jawnClient.PATCH(
          "/v1/prompt/{promptId}/user-defined-id",
          {
            params: {
              path: {
                promptId: prompt?.id || "",
              },
            },
            body: {
              userDefinedId: kebabId,
            },
          }
        );

        if (result.error) {
          setNotification("Failed to update prompt ID.", "error");
          return;
        }

        setNotification(`Updated prompt ID to ${kebabId}.`, "success");
        await refetchPrompt();
      }
    },
    [id, jawnClient, prompt?.id, refetchPrompt, setNotification]
  );
  // - Save &/Or Run
  const handleSaveAndRun = useCallback(async () => {
    if (!state || !canRun) return;

    // 1. ABORT: If already streaming
    if (isStreaming) {
      abortController.current?.abort();
      setIsStreaming(false);
      return;
    }

    // 2. STREAMING STATE + CLEAR RESPONSE
    setIsStreaming(true);
    updateState({ response: "" }, false);

    const variables = state.variables || [];
    const variableMap = Object.fromEntries(
      variables.map((v) => [v.name, v.value || ""])
    );

    // 3. SAVE: If dirty
    if (state.isDirty) {
      const latestVersionId = promptVersions?.[0]?.id;
      if (!latestVersionId) return;

      // 3.1. Build Helicone Template for Saving
      const heliconeTemplate = {
        model: state.parameters.model,
        temperature: state.parameters.temperature,
        messages: state.messages,
      };

      const metadata = {
        isProduction: false,
        createdFromUi: true,
        provider: state.parameters.provider,
        inputs: variableMap,
      };

      try {
        let result = await jawnClient.POST(
          "/v1/prompt/version/{promptVersionId}/subversion",
          {
            params: { path: { promptVersionId: latestVersionId } },
            body: {
              newHeliconeTemplate: heliconeTemplate,
              metadata,
              isMajorVersion: true,
            },
          }
        );

        if (result?.error || !result?.data) {
          setNotification("Error saving prompt", "error");
          return;
        }

        loadVersionData(result.data.data);
        await refetchPromptVersions();
      } catch (error) {
        console.error("Save error:", error);
        setNotification("Failed to save and run prompt", "error");
        return;
      }
    }

    // 5. RUN: Use autoFillInputs to handle variable replacement
    const runTemplate = {
      ...state.parameters,
      messages: autoFillInputs({
        inputs: variableMap,
        autoInputs: [],
        template: state.messages,
      }),
    };
    console.log("Run template:", runTemplate);

    // 6. EXECUTE
    try {
      abortController.current = new AbortController();

      try {
        const stream = await generateStream({
          ...runTemplate,
          signal: abortController.current.signal,
        } as any);

        await readStream(
          stream,
          (chunk: string) => {
            setState((prev) => {
              if (!prev) return null;
              return {
                ...prev,
                response: (prev.response || "") + chunk,
              };
            });
          },
          abortController.current.signal
        );
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("Error:", error);
          setNotification(error.message, "error");
        }
      } finally {
        setIsStreaming(false);
        abortController.current = null;
      }
    } catch (error) {
      console.error("Failed to save state:", error);
      setNotification("Failed to save prompt state", "error");
      setIsStreaming(false);
    }
  }, [
    state,
    isStreaming,
    canRun,
    jawnClient,
    setNotification,
    refetchPromptVersions,
    loadVersionData,
    updateState,
    promptVersions,
  ]);

  // EFFECTS
  // - Load Initial State
  useEffect(() => {
    if (
      !state &&
      promptVersions &&
      promptVersions.length > 0 &&
      !isVersionsLoading
    ) {
      loadVersionData(promptVersions[0]);
    }
  }, [isVersionsLoading, loadVersionData, promptVersions, state]);
  // - Handle Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        prompt?.metadata?.createdFromUi !== false
      ) {
        event.preventDefault();
        handleSaveAndRun();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSaveAndRun, prompt?.metadata?.createdFromUi]);

  // HELPERS
  // - Add Message Pair
  const handleAddMessagePair = () => {
    updateState((prev) => {
      if (prev && isLastMessageUser(prev.messages)) {
        return {
          messages: [
            ...prev.messages,
            { role: "assistant", content: "" },
            { role: "user", content: "" },
          ],
        };
      } else return {};
    });
  };
  // - Add Prefill
  const handleAddPrefill = () => {
    updateState((prev) => {
      if (
        prev &&
        isPrefillSupported(prev.parameters.provider) &&
        isLastMessageUser(prev.messages)
      ) {
        return {
          messages: [...prev.messages, { role: "assistant", content: "" }],
        };
      } else return {};
    });
  };

  // RENDER
  // - Loading Page
  if (isPromptLoading || isVersionsLoading || !state) {
    return (
      <div className="flex h-screen items-center justify-center">
        <LoadingAnimation title="Loading prompt..." />
      </div>
    );
  }
  // - Page
  return (
    <Tabs className="relative flex flex-col" defaultValue="editor">
      {/* Header */}
      <GlassHeader>
        {/* Left Side: Navigation */}
        <div className="flex flex-row items-center gap-2">
          <Link
            className="text-base text-slate-500 hover:text-heliblue"
            href="/prompts"
          >
            <PiCaretLeftBold />
          </Link>
          <VersionSelector
            id={prompt?.user_defined_id || ""}
            currentVersion={state.version}
            masterVersion={state.masterVersion}
            versions={promptVersions || []}
            isLoading={isVersionsLoading}
            isDirty={state.isDirty}
            onVersionSelect={loadVersionData}
            onVersionPromote={handleVersionPromote}
            onIdEdit={handleIdEdit}
          />
          <TabsList className="grid grid-cols-2">
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>
        </div>

        {/* Right Side: Actions */}
        <div className="flex flex-row items-center gap-2">
          {/* Run Button */}
          <ActionButton
            label={isStreaming ? "Stop" : state.isDirty ? "Save & Run" : "Run"}
            icon={isStreaming ? PiStopBold : PiPlayBold}
            className={
              isStreaming
                ? "bg-red-500 hover:bg-red-500/90 text-white"
                : "bg-heliblue hover:bg-heliblue/90 text-white"
            }
            onClick={handleSaveAndRun}
            disabled={!canRun}
          >
            {isStreaming && <PiSpinnerGapBold className="animate-spin" />}

            <div
              className={`flex items-center gap-1 text-sm ${
                canRun && prompt?.metadata?.createdFromUi !== false
                  ? "text-white opacity-60"
                  : "text-slate-400"
              }`}
            >
              <PiCommandBold className="h-4 w-4" />
              <MdKeyboardReturn className="h-4 w-4" />
            </div>
          </ActionButton>

          {/* Deploy Button */}
          <Dialog>
            <DialogTrigger asChild>
              <ActionButton
                label="Deploy"
                className="bg-white"
                icon={PiRocketLaunchBold}
                onClick={() => {}}
                disabled={prompt?.metadata?.createdFromUi === false}
              />
            </DialogTrigger>
            <DialogContent className="w-full max-w-3xl bg-white">
              <DialogHeader>
                <DialogTitle>Deploy Prompt</DialogTitle>
              </DialogHeader>

              {/* Code example */}
              <DiffHighlight
                code={`
export async function getPrompt(
  id: string,
  variables: Record<string, any>
): Promise<any> {
  const getHeliconePrompt = async (id: string) => {
    const res = await fetch(
      \`https://api.helicone.ai/v1/prompt/\${id}/template\`,
      {
        headers: {
          Authorization: \`Bearer \${YOUR_HELICONE_API_KEY}\`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          inputs: variables,
        }),
      }
    );

    return (await res.json()) as Result<PromptVersionCompiled, any>;
  };

  const heliconePrompt = await getHeliconePrompt(id);
  if (heliconePrompt.error) {
    throw new Error(heliconePrompt.error);
  }
  return heliconePrompt.data?.filled_helicone_template;
}

async function pullPromptAndRunCompletion() {
  const prompt = await getPrompt("${
    prompt?.user_defined_id || "my-prompt-id"
  }", {
    ${
      state?.variables
        ?.map((v) => `${v.name}: "${v.value || "value"}"`)
        .join(",\n    ") || 'color: "red"'
    }
  });
  console.log(prompt);

  const openai = new OpenAI({
    apiKey: "YOUR_OPENAI_API_KEY",
    baseURL: \`https://oai.helicone.ai/v1/\${YOUR_HELICONE_API_KEY}\`,
  });
  const response = await openai.chat.completions.create(
    prompt satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
  );
  console.log(response);
}`}
                language="typescript"
                newLines={[]}
                oldLines={[]}
                minHeight={false}
              />
            </DialogContent>
          </Dialog>

          {/* Experiment Button */}
          <ActionButton
            label="Experiment"
            className="bg-white"
            icon={<FlaskConicalIcon className="h-4 w-4" />}
            disabled={newFromPromptVersion.isLoading}
            onClick={async () => {
              const result = await newFromPromptVersion.mutateAsync({
                name: `${prompt?.user_defined_id}_V${state.version}.${state.versionId}`,
                originalPromptVersion: state.versionId,
              });
              router.push(`/experiments/${result.data?.data?.experimentId}`);
            }}
          />
        </div>
      </GlassHeader>

      {/* Prompt Editor Tab */}
      <TabsContent className="p-4" value="editor">
        <ResizablePanels
          leftPanel={
            <MessagesPanel
              messages={state.messages}
              onMessageChange={handleMessageChange}
              onAddMessagePair={handleAddMessagePair}
              onAddPrefill={handleAddPrefill}
              onRemoveMessage={handleRemoveMessage}
              onVariableCreate={handleVariableCreate}
              variables={state.variables || []}
              isPrefillSupported={isPrefillSupported(state.parameters.provider)}
            />
          }
          rightPanel={
            <div className="flex h-full flex-col gap-4">
              <ResponsePanel response={state.response || ""} />

              <VariablesPanel
                variables={state.variables || []}
                onVariableChange={handleVariableChange}
                promptVersionId={state.versionId}
              />

              <ParametersPanel
                parameters={state.parameters}
                onParameterChange={(updates) => {
                  updateState((prev) => {
                    if (!prev) return {};
                    return {
                      parameters: {
                        ...prev.parameters,
                        ...updates,
                      },
                    };
                  });
                }}
              />
            </div>
          }
        />
      </TabsContent>

      {/* Metrics Tab */}
      <TabsContent value="metrics">
        <PromptMetricsTab
          id={id}
          promptUserDefinedId={prompt?.user_defined_id || ""}
        />
      </TabsContent>
    </Tabs>
  );
}
