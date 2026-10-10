export type ConfirmationTone = "warning" | "danger";

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  detail?: string;
  tone?: ConfirmationTone;
};

export type ConfirmationSnapshot = {
  id: number;
  options: ConfirmationOptions;
};

let nextId = 1;
let snapshot: ConfirmationSnapshot | null = null;
let resolver: ((accepted: boolean) => void) | null = null;
const listeners = new Set<() => void>();

export function requestConfirmation(options: ConfirmationOptions) {
  const previousResolver = resolver;
  resolver = null;
  snapshot = null;
  previousResolver?.(false);

  return new Promise<boolean>((resolve) => {
    snapshot = { id: nextId++, options };
    resolver = resolve;
    emit();
  });
}

export function resolveConfirmation(id: number, accepted: boolean) {
  if (!snapshot || snapshot.id !== id || !resolver) return;
  const activeResolver = resolver;
  resolver = null;
  snapshot = null;
  emit();
  activeResolver(accepted);
}

export function subscribeToConfirmation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getConfirmationSnapshot() {
  return snapshot;
}

export function resetConfirmationForTests() {
  const activeResolver = resolver;
  resolver = null;
  snapshot = null;
  activeResolver?.(false);
  emit();
}

function emit() {
  for (const listener of listeners) listener();
}
