/**
 * The pages ingested in version 1: a part of the handbook around what the assistant answers
 * (time off, leave, expenses, travel, benefits, onboarding, ways of working). The golden
 * questions in evals/handbook-golden.json only point at these pages.
 *
 * To ingest more, add URLs here, or send `handbook/ingest.requested` with your own `urls`.
 * Every URL must be a handbook page (https://handbook.gitlab.com/...); others are refused.
 */
export const HANDBOOK_PAGES = [
    "https://handbook.gitlab.com/handbook/people-group/time-off-and-absence/",
    "https://handbook.gitlab.com/handbook/people-group/time-off-and-absence/time-off-types/",
    "https://handbook.gitlab.com/handbook/people-group/time-off-and-absence/leave-types/",
    "https://handbook.gitlab.com/handbook/people-group/time-off-and-absence/time-away-philosophy/",
    "https://handbook.gitlab.com/handbook/people-policies/leave-of-absence/",
    "https://handbook.gitlab.com/handbook/total-rewards/benefits/parental-leave-toolkit/",
    "https://handbook.gitlab.com/handbook/total-rewards/benefits/general-and-entity-benefits/",
    "https://handbook.gitlab.com/handbook/finance/expenses/",
    "https://handbook.gitlab.com/handbook/finance/travel/",
    "https://handbook.gitlab.com/handbook/finance/travel/sponsored/",
    "https://handbook.gitlab.com/handbook/finance/procurement/",
    "https://handbook.gitlab.com/handbook/people-group/learning-and-development/growth-and-development/",
    "https://handbook.gitlab.com/handbook/people-group/general-onboarding/",
    "https://handbook.gitlab.com/handbook/people-group/offboarding/",
    "https://handbook.gitlab.com/handbook/people-group/anti-harassment/",
    "https://handbook.gitlab.com/handbook/company/culture/all-remote/guide/",
    "https://handbook.gitlab.com/handbook/company/culture/all-remote/getting-started/",
    "https://handbook.gitlab.com/handbook/communication/",
    "https://handbook.gitlab.com/handbook/leadership/1-1/",
    "https://handbook.gitlab.com/handbook/tools-and-tips/",
]
