import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { clsx } from "../../../../../../shared/clsx";
import { RenderWithPrettyInputKeys } from "../../../../../playground/chatRow";
import { isJSON } from "./utils";
import { Col } from "../../../../../../layout/common";
import MarkdownEditor from "../../../../../../shared/markdownEditor";
import { PROMPT_MODES } from "../chatTopBar";

interface ExpandableMessageProps {
  formattedMessageContent: string;
  textContainerRef: React.RefObject<HTMLDivElement>;
  expandedProps: {
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
  };

  selectedProperties?: Record<string, string>;
  mode: (typeof PROMPT_MODES)[number];
}

export const ExpandableMessage: React.FC<ExpandableMessageProps> = ({
  formattedMessageContent,
  textContainerRef,
  expandedProps: { expanded, setExpanded },

  selectedProperties,
  mode,
}) => {
  const handleToggle = () => setExpanded(!expanded);

  const parentRef = useRef<HTMLDivElement>(null);

  const contentRef = useRef<HTMLDivElement>(null);

  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    if (!contentRef.current || !parentRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        console.log("New scroll height:", entry.target.scrollHeight);
        if (
          entry.target.scrollHeight > (parentRef.current?.clientHeight ?? 0)
        ) {
          setShowButton(true);
        }
      }
    });

    resizeObserver.observe(contentRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [contentRef, parentRef]);

  const expandFormat = useMemo(() => {
    return !expanded && showButton;
  }, [expanded, showButton]);

  if (formattedMessageContent.length > 2_000_000) {
    return (
      <div className="text-red-500 font-normal">
        Too long to display (Length = {formattedMessageContent.length})
      </div>
    );
  }

  return (
    <Col ref={parentRef}>
      <div
        className={clsx(
          expandFormat ? "truncate-text" : "",
          "leading-6 pb-2 max-w-full transition-all"
        )}
        style={{ maxHeight: expanded ? "none" : "10.5rem" }}
      >
        <div className="h-full" ref={contentRef}>
          {mode === "Pretty" ? (
            <RenderWithPrettyInputKeys
              text={
                isJSON(formattedMessageContent)
                  ? JSON.stringify(JSON.parse(formattedMessageContent), null, 2)
                  : formattedMessageContent
              }
              selectedProperties={selectedProperties}
            />
          ) : (
            <MarkdownEditor
              language="markdown"
              text={formattedMessageContent}
              setText={() => {}}
              className=""
            />
          )}
        </div>
      </div>
      {showButton && (
        <div className="w-full flex justify-center items-center pt-2 pr-24">
          <button onClick={handleToggle}>
            <ChevronDownIcon
              className={clsx(
                "rounded-full border text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700 h-7 w-7 p-1.5",
                expanded && "transition-transform rotate-180"
              )}
            />
          </button>
        </div>
      )}
    </Col>
  );
};
