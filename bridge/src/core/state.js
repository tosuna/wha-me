export const initialState = () => ({ paused: false, locked: false, shadow: true });

const yn = (v) => (v ? 'si' : 'no');

export function applyCommand(state, text) {
  const cmd = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  switch (cmd) {
    case '/pausa': return { state: { ...state, paused: true }, reply: 'listo, en pausa' };
    case '/sigue': return { state: { ...state, paused: false }, reply: 'listo, sigo' };
    case '/desbloquear': return { state: { ...state, locked: false }, reply: 'listo, desbloqueado' };
    case '/sombra on': return { state: { ...state, shadow: true }, reply: 'listo, modo sombra activado' };
    case '/sombra off': return { state: { ...state, shadow: false }, reply: 'listo, modo sombra desactivado' };
    case '/sombra': return { state: { ...state }, reply: 'usa /sombra on o /sombra off' };
    case '/estado':
      return {
        state: { ...state },
        reply: `pausa: ${yn(state.paused)}, bloqueo: ${yn(state.locked)}, sombra: ${yn(state.shadow)}`,
      };
    default: return null;
  }
}
