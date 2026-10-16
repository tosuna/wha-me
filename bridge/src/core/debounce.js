export function createDebouncer({ setTimer, clearTimer, delayMs }) {
  const handles = new Map();
  const cancel = (key) => {
    if (handles.has(key)) clearTimer(handles.get(key));
    handles.delete(key);
  };
  return {
    bump(key, fn) {
      cancel(key);
      handles.set(key, setTimer(() => { handles.delete(key); fn(); }, delayMs()));
    },
    cancel,
    pending: (key) => handles.has(key),
  };
}
