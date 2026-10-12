import {
  agentCanvasContextSchema,
  agentConversationSchema,
  agentMessageSchema,
  agentModelIdSchema,
  type AgentCanvasContext,
  type AgentConversation,
  type AgentMessage,
} from "@weftcanvas/contracts";
import { z } from "zod";

import { normalizeAgentCreativeGuidance } from "./creative-guidance.js";

export const agentExecutionRequestSchema = z
  .object({
    modelId: agentModelIdSchema,
    reasoningEffort: z.string().trim().min(1).max(24).optional(),
    conversation: agentConversationSchema,
    messages: z.array(agentMessageSchema).min(1).max(500),
    canvasContext: agentCanvasContextSchema,
    /**
     * 归属用户。托管站点上"用户自己的机器"只能通过配对通道找回来，
     * 运行时用它在 API 上派发任务（本机开发时不需要）。
     */
    ownerId: z.string().trim().min(1).max(128).optional(),
    /**
     * 该用户当前在线、可远程执行的外部连接。为真时本轮用远程通道，
     * 而不是去连本机的 Blender。
     */
    remoteConnectors: z
      .object({
        blender: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conversation.projectId !== value.canvasContext.projectId) {
      context.addIssue({
        code: "custom",
        message: "Conversation project does not match canvas context",
        path: ["canvasContext", "projectId"],
      });
    }
    for (const [index, message] of value.messages.entries()) {
      if (message.conversationId !== value.conversation.id) {
        context.addIssue({
          code: "custom",
          message: "Message conversation id mismatch",
          path: ["messages", index, "conversationId"],
        });
      }
    }
    const last = value.messages.at(-1);
    if (!last || last.role !== "user") {
      context.addIssue({
        code: "custom",
        message: "Last message must be from the user",
        path: ["messages"],
      });
    }
  });

export type AgentExecutionRequest = {
  modelId: string;
  reasoningEffort?: string;
  conversation: AgentConversation;
  messages: AgentMessage[];
  canvasContext: AgentCanvasContext;
  ownerId?: string;
  remoteConnectors?: { blender: boolean };
};

export function parseAgentExecutionRequest(value: unknown): AgentExecutionRequest {
  const request = agentExecutionRequestSchema.parse(value);
  const guidance = request.canvasContext.creativeGuidance;
  if (!guidance || guidance.mode !== "baseline") return request;
  return {
    ...request,
    canvasContext: {
      ...request.canvasContext,
      creativeGuidance: normalizeAgentCreativeGuidance(guidance),
    },
  };
}
