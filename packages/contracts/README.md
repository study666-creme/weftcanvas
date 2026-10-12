# Contracts

This package will own versioned schemas for:

- canvas commands and domain events
- Agent runs, progress, guidance, queues, and cancellation
- generation jobs, media validation, and recovery
- provider-neutral identity claims and shared-wallet operations
- versioned model catalog, capabilities, parameters, availability, and quotes

Contracts contain no private prompts, model credentials, or runtime logic.

The current identity contract covers registration and login through the
configured provider, the public user profile, session state, and logout
response. It deliberately contains no session token field: browser session
credentials live only in an HttpOnly cookie. In official production, Prompt
Hub is the identity and shared-credit authority; the contracts do not imply a
second Canvas wallet.

The media contract covers owner-neutral upload intents, processing states,
trusted dimensions and duration, integrity hashes, and safe errors. Object keys,
storage credentials, upload claims, revisions, and owner ids are private API
records and cannot be supplied through the public schema.

`pnpm --filter @weftcanvas/contracts build` emits the ESM runtime used by Node
services. TypeScript consumers continue to read the source declarations, while
browser and server runtimes import the generated JavaScript package entry.

The public generation-job contract contains product status, progress, quotes,
validated artifacts, and safe errors. Owner ids, provider task ids, result
staging references, reservations, revisions, and raw responses remain in the
server record and are removed by the public response schema.
