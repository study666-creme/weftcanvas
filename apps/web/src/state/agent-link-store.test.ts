import { beforeEach, describe, expect, it } from "vitest";

import { MAX_AGENT_LINKED_NODES, useAgentLinkStore } from "./agent-link-store";

describe("agent link store", () => {
  beforeEach(() => {
    useAgentLinkStore.setState({ linksByProject: {} });
  });

  it("toggles a node link per project and caps the list", () => {
    const store = useAgentLinkStore.getState();
    store.toggle("project-a", "node-1");
    store.toggle("project-a", "node-2");
    store.toggle("project-b", "node-1");
    expect(useAgentLinkStore.getState().linksByProject).toEqual({
      "project-a": ["node-1", "node-2"],
      "project-b": ["node-1"],
    });

    store.toggle("project-a", "node-1");
    expect(useAgentLinkStore.getState().linksByProject["project-a"]).toEqual(["node-2"]);

    for (let index = 0; index < MAX_AGENT_LINKED_NODES + 3; index += 1) {
      store.toggle("project-a", `extra-${index}`);
    }
    expect(useAgentLinkStore.getState().linksByProject["project-a"]).toHaveLength(
      MAX_AGENT_LINKED_NODES,
    );
  });

  it("prunes deleted nodes and removes the project entry when empty", () => {
    const store = useAgentLinkStore.getState();
    store.toggle("project-a", "node-1");
    store.toggle("project-a", "node-2");
    store.prune("project-a", new Set(["node-2"]));
    expect(useAgentLinkStore.getState().linksByProject["project-a"]).toEqual(["node-2"]);
    store.prune("project-a", new Set());
    expect(useAgentLinkStore.getState().linksByProject["project-a"]).toBeUndefined();
  });
});
