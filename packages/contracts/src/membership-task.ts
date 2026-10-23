import { z } from "zod";

export const membershipTaskItemSchema = z.object({
  key: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  rewardDays: z.number().int().min(0).max(3650),
  rewardCredits: z.number().finite().min(0),
  rewardTier: z.enum(["lite", "basic", "standard", "pro"]).optional(),
  claimed: z.boolean(),
  ready: z.boolean(),
  progress: z.string().trim().max(120).nullable(),
  kind: z.enum(["claim", "promo"]),
});
export type MembershipTaskItem = z.infer<typeof membershipTaskItemSchema>;

const membershipDailyTaskSchema = z.object({
  key: z.string().trim().min(1).max(64),
  claimed: z.boolean(),
  ready: z.boolean(),
});

export const membershipTaskHubSchema = z
  .object({
    phoneVerified: z.boolean(),
    signStreak: z.number().int().min(0),
    checkedInToday: z.boolean(),
    daysToStreakBonus: z.number().int().min(0).max(7),
    dailyBonus: membershipDailyTaskSchema,
    memberDaily: membershipDailyTaskSchema
      .extend({
        /** 原价口径的每日额度 */
        amount: z.number().finite().min(0),
        /**
         * 活动加赠：amount 是基础额度，bonus 是加赠部分，total 是实发合计。
         * 旧版 Prompt Hub 只下发 amount，此时按「无加赠」处理。
         */
        bonus: z.number().finite().min(0).optional(),
        total: z.number().finite().min(0).optional(),
      })
      .nullable(),
  })
  .passthrough();

export const membershipTaskCenterSchema = z
  .object({
    items: z.array(membershipTaskItemSchema).max(128),
    lifetimeCreditsSpent: z.number().finite().min(0),
    nextSpendMilestone: z.number().finite().min(0).nullable(),
    hub: membershipTaskHubSchema,
    phoneVerified: z.boolean().optional(),
  })
  .passthrough();
export type MembershipTaskCenter = z.infer<typeof membershipTaskCenterSchema>;

export const membershipTaskCenterResponseSchema = z.object({
  ok: z.literal(true),
  data: membershipTaskCenterSchema,
});

export const membershipTaskActionResponseSchema = z.object({
  ok: z.literal(true),
  data: z
    .object({
      message: z.string().trim().min(1).max(500),
      granted: z.boolean().optional(),
    })
    .passthrough(),
});
export type MembershipTaskAction = z.infer<typeof membershipTaskActionResponseSchema>["data"];

export const membershipTaskKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+(?:_[0-9-]+)?$/i);
