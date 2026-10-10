import { create } from "zustand";

type CollaborationDialogState = {
  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;
};

export const useCollaborationDialogStore = create<CollaborationDialogState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
}));
