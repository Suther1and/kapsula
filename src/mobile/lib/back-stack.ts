type BackHandler = () => void;

const backHandlers: Array<{ id: number; handler: BackHandler }> = [];
let nextBackId = 1;

/**
 * Registers an overlay/modal handler on the LIFO Android Back stack.
 * When Android Back is pressed, the most recently opened overlay closes first.
 */
export function pushBackHandler(handler: BackHandler): () => void {
  const id = nextBackId++;
  backHandlers.push({ id, handler });
  return () => {
    const idx = backHandlers.findIndex((entry) => entry.id === id);
    if (idx !== -1) {
      backHandlers.splice(idx, 1);
    }
  };
}

/**
 * Invokes the top-most registered overlay Back handler if one exists.
 * Returns true if an overlay consumed the Back gesture.
 */
export function consumeTopBackHandler(): boolean {
  const top = backHandlers[backHandlers.length - 1];
  if (!top) return false;
  top.handler();
  return true;
}
