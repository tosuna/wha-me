// ActionAdapter: the domain action behind the reply agent's `APPROVE: <id>[, <id>]` directive (config actions). Duck-typed:
//   idPattern: RegExp | null — one valid id, anchored (core/parse.js reads the directive with it). null: every APPROVE line
//     is malformed.
//   precheck(contact, approve) -> string | null — static gate, no I/O; also the shadow-mode answer. approve: the parsed
//     directive, { folios } or { folios: null, error }. null = would go on, else the refusal reason (Spanish, for the owner).
//   approve({ contact, approve }) -> Promise<{ ok: true, done } | { ok: false, reason, done? }> — applies precheck itself,
//     never throws. done: one self-chat note per action that happened, also before a mid-way failure (it may not be undoable).
//   reviewHint(profile) -> string — optional: the `next` step of the owner's handoff when approve() refused (where to
//     review the request by hand). Absent: reviewHint below.
// The agent's reply is only sent when approve() resolved ok; otherwise the contact gets a neutral ack and the owner a
// blocking 'approval' handoff (bridge.js act).
// Adapters keep their state in closures: loadConfig freezes them.

const OFF = 'aprobación automática no configurada';

// Generic next step of a refused approval: names no system.
export const reviewHint = (profile) => `${profile.name} revisa la solicitud`;

// No domain action: every APPROVE is refused, like a contact without auto-approval.
export const none = () => ({ idPattern: null, precheck: () => OFF, approve: async () => ({ ok: false, reason: OFF }), reviewHint });
