export const replyDelayMs = (rng = Math.random) => 180000 + rng() * 180000;
// Persona chats (banter): answer while the conversation is still going.
export const personaDelayMs = (rng = Math.random) => 20000 + rng() * 40000;
export const typingMs = (text, rng = Math.random) => (text.length / 4) * 1000 * (0.8 + rng() * 0.4);
export const bubbleGapMs = (rng = Math.random) => 1500 + rng() * 2500;
// Shadow sends nothing to contacts: only a short debounce so a burst of messages still becomes one run.
export const shadowDelayMs = () => 15000;
