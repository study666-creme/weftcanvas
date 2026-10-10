import {
  createDirectorStageStarterPacket,
  DIRECTOR_STAGE_PREVIEW_BATCH_SIZE,
  normalizeDirectorStagePacket,
  type DirectorStageActorPose,
  type DirectorStageCapture,
  type DirectorStagePacket,
  type DirectorStagePropPose,
  type DirectorStageSlot,
} from "@kachang/contracts";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  CopyPlus,
  Download,
  FileJson,
  Focus,
  ImagePlus,
  Images,
  LockKeyhole,
  PackagePlus,
  RotateCcw,
  Trash2,
  UnlockKeyhole,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { ThemeMode } from "../App";
import {
  DirectorStageRuntime,
  type StageEntitySnapshot,
  type StageEntityTransform,
} from "../lib/director-stage-runtime";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";
import { useToastStore } from "../state/toast-store";

type DirectorStageProps = {
  open: boolean;
  projectId: string;
  theme: ThemeMode;
  onClose: () => void;
  onCapture: (captures: DirectorStageCapture[]) => Promise<string[]>;
  initialPacket?: DirectorStagePacket | null;
};

type PersistedStage = {
  packet: DirectorStagePacket;
  allowBelowGround: boolean;
};

const PROP_OPTIONS = ["桌子", "椅子", "沙发", "床", "门", "窗", "台灯", "箱子"];

export function DirectorStage({ open, projectId, theme, onClose, onCapture, initialPacket = null }: DirectorStageProps) {
  const initialStageRef = useRef<PersistedStage | null>(null);
  if (!initialStageRef.current) initialStageRef.current = readPersistedStage(projectId, initialPacket);
  const initialStage = initialStageRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const runtimeRef = useRef<DirectorStageRuntime | null>(null);
  const packetRef = useRef<DirectorStagePacket>(initialStage.packet);
  const activeShotIdRef = useRef(firstSlot(packetRef.current).shot_id);
  const [packet, setPacket] = useState(packetRef.current);
  const [activeShotId, setActiveShotId] = useState(activeShotIdRef.current);
  const [selected, setSelected] = useState<StageEntitySnapshot | null>(null);
  const [allowBelowGround, setAllowBelowGround] = useState(initialStage.allowBelowGround);
  const allowBelowGroundRef = useRef(initialStage.allowBelowGround);
  const [capturing, setCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState({ current: 0, total: 0 });
  const [draggingEntity, setDraggingEntity] = useState(false);
  const [propMenuOpen, setPropMenuOpen] = useState(false);
  const pendingAgentAction = useDirectorStageLaunchStore((state) => state.pendingAgentActions[0] ?? null);
  const completeAgentAction = useDirectorStageLaunchStore((state) => state.completeAgentAction);
  const showToast = useToastStore((state) => state.show);

  const activeSlot = useMemo(
    () => packet.slots.find((slot) => slot.shot_id === activeShotId) ?? firstSlot(packet),
    [activeShotId, packet],
  );
  const activeShotIndex = Math.max(0, packet.slots.findIndex((slot) => slot.shot_id === activeSlot?.shot_id));
  const activeBatchIndex = Math.floor(activeShotIndex / DIRECTOR_STAGE_PREVIEW_BATCH_SIZE);
  const totalBatches = Math.max(1, Math.ceil(packet.slots.length / DIRECTOR_STAGE_PREVIEW_BATCH_SIZE));
  const activeBatchSlots = useMemo(() => {
    const start = activeBatchIndex * DIRECTOR_STAGE_PREVIEW_BATCH_SIZE;
    return packet.slots.slice(start, start + DIRECTOR_STAGE_PREVIEW_BATCH_SIZE);
  }, [activeBatchIndex, packet.slots]);

  const replacePacket = useCallback((next: DirectorStagePacket) => {
    packetRef.current = next;
    setPacket(next);
  }, []);

  const selectShot = useCallback((shotId: string) => {
    const slot = packetRef.current.slots.find((item) => item.shot_id === shotId);
    if (!slot) return;
    activeShotIdRef.current = shotId;
    setActiveShotId(shotId);
    setSelected(null);
    runtimeRef.current?.applySlot(slot);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(stageStorageKey(projectId), JSON.stringify({ packet, allowBelowGround } satisfies PersistedStage));
  }, [allowBelowGround, packet, projectId]);

  useEffect(() => {
    allowBelowGroundRef.current = allowBelowGround;
  }, [allowBelowGround]);

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    const runtime = new DirectorStageRuntime(canvasRef.current, theme === "dark");
    runtimeRef.current = runtime;
    const slot = packetRef.current.slots.find((item) => item.shot_id === activeShotIdRef.current) ?? firstSlot(packetRef.current);
    runtime.applySlot(slot);

    const resizeObserver = new ResizeObserver(runtime.resize);
    resizeObserver.observe(canvasRef.current);

    const pointerDown = (event: PointerEvent) => {
      const snapshot = runtime.beginEntityDrag(event);
      setSelected(snapshot);
      setDraggingEntity(runtime.isDraggingEntity());
    };
    const pointerMove = (event: PointerEvent) => {
      const snapshot = runtime.moveEntityDrag(event);
      if (snapshot) setSelected(snapshot);
    };
    const pointerEnd = (event: PointerEvent) => {
      const snapshot = runtime.endEntityDrag(event);
      setDraggingEntity(false);
      if (snapshot) persistEntityTransform(snapshot);
    };
    const persistCamera = () => {
      const shotId = activeShotIdRef.current;
      const camera = runtime.getCamera();
      const next = {
        ...packetRef.current,
        slots: packetRef.current.slots.map((item) => item.shot_id === shotId
          ? { ...item, camera: { ...item.camera, x: camera.x, y: camera.y, z: camera.z, fov: camera.fov } }
          : item),
      };
      replacePacket(next);
    };
    const syncTransformSelection = () => {
      let snapshot = runtime.getSelectedEntity();
      if (!snapshot) return null;
      if (!allowBelowGroundRef.current && snapshot.y < 0) {
        snapshot = runtime.updateEntity(snapshot.id, { ...snapshot, y: 0 });
      }
      setSelected(snapshot);
      return snapshot;
    };
    const persistTransformSelection = () => {
      const snapshot = syncTransformSelection();
      if (snapshot) persistEntityTransform(snapshot);
    };
    const updateTransformDragging = (event: { value?: unknown }) => {
      setDraggingEntity(Boolean(event.value));
    };

    canvasRef.current.addEventListener("pointerdown", pointerDown);
    canvasRef.current.addEventListener("pointermove", pointerMove);
    canvasRef.current.addEventListener("pointerup", pointerEnd);
    canvasRef.current.addEventListener("pointercancel", pointerEnd);
    runtime.controls.addEventListener("end", persistCamera);
    runtime.transformControls.addEventListener("objectChange", syncTransformSelection);
    runtime.transformControls.addEventListener("mouseUp", persistTransformSelection);
    runtime.transformControls.addEventListener("dragging-changed", updateTransformDragging);

    return () => {
      resizeObserver.disconnect();
      canvasRef.current?.removeEventListener("pointerdown", pointerDown);
      canvasRef.current?.removeEventListener("pointermove", pointerMove);
      canvasRef.current?.removeEventListener("pointerup", pointerEnd);
      canvasRef.current?.removeEventListener("pointercancel", pointerEnd);
      runtime.controls.removeEventListener("end", persistCamera);
      runtime.transformControls.removeEventListener("objectChange", syncTransformSelection);
      runtime.transformControls.removeEventListener("mouseUp", persistTransformSelection);
      runtime.transformControls.removeEventListener("dragging-changed", updateTransformDragging);
      runtime.dispose();
      runtimeRef.current = null;
      setDraggingEntity(false);
    };
  }, [open, replacePacket, theme]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (propMenuOpen) setPropMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose, open, propMenuOpen]);

  const persistEntityTransform = (snapshot: StageEntitySnapshot) => {
    const entityId = snapshot.id.replace(/^(actor|prop):/, "");
    const shotId = activeShotIdRef.current;
    const pose = {
      x: snapshot.x,
      y: snapshot.y,
      z: snapshot.z,
      rotation_y: snapshot.rotationY,
      scale: snapshot.scale,
    };
    const next = {
      ...packetRef.current,
      slots: packetRef.current.slots.map((slot) => slot.shot_id !== shotId
        ? slot
        : {
            ...slot,
            subjects: snapshot.kind === "actor"
              ? slot.subjects.map((actor) => actor.id === entityId ? { ...actor, ...pose } : actor)
              : slot.subjects,
            props: snapshot.kind === "prop"
              ? slot.props.map((prop) => prop.id === entityId ? { ...prop, ...pose } : prop)
              : slot.props,
          }),
    };
    replacePacket(next);
    setSelected(snapshot);
  };

  const updateSelected = (patch: Partial<StageEntityTransform>) => {
    if (!selected) return;
    const next: StageEntitySnapshot = { ...selected, ...patch };
    if (!allowBelowGround && next.y < 0) {
      next.y = 0;
      showToast("已在地面停止；开启“允许地下”后可继续下移", "info");
    }
    const updated = runtimeRef.current?.updateEntity(selected.id, next) ?? next;
    persistEntityTransform(updated);
  };

  const commitActiveSlot = (nextSlot: DirectorStageSlot, selectedId = "") => {
    const next = {
      ...packetRef.current,
      slots: packetRef.current.slots.map((slot) => slot.shot_id === nextSlot.shot_id ? nextSlot : slot),
    };
    replacePacket(next);
    runtimeRef.current?.applySlot(nextSlot);
    setSelected(selectedId ? runtimeRef.current?.selectEntity(selectedId) ?? null : null);
  };

  useEffect(() => {
    if (!open || !pendingAgentAction) return;
    if (pendingAgentAction.type === "canvas_director_select_shot") {
      const exists = packetRef.current.slots.some((slot) => slot.shot_id === pendingAgentAction.shotId);
      if (exists) selectShot(pendingAgentAction.shotId);
      else showToast("Agent 指定的镜头不存在", "error");
      completeAgentAction();
      return;
    }

    const action = pendingAgentAction;
    const slot = packetRef.current.slots.find((item) => item.shot_id === action.shotId);
    const source = action.entityKind === "actor"
      ? slot?.subjects.find((item) => item.id === action.entityId)
      : slot?.props.find((item) => item.id === action.entityId);
    if (!slot || !source) {
      showToast("Agent 指定的导演台对象不存在", "error");
      completeAgentAction();
      return;
    }

    const y = action.patch.y === undefined
      ? source.y
      : allowBelowGround ? action.patch.y : Math.max(0, action.patch.y);
    const posePatch = {
      ...(action.patch.x === undefined ? {} : { x: action.patch.x }),
      y,
      ...(action.patch.z === undefined ? {} : { z: action.patch.z }),
      ...(action.patch.rotationY === undefined ? {} : { rotation_y: action.patch.rotationY }),
      ...(action.patch.scale === undefined ? {} : { scale: action.patch.scale }),
    };
    const nextSlot: DirectorStageSlot = {
      ...slot,
      subjects: action.entityKind === "actor"
        ? slot.subjects.map((item) => item.id === action.entityId ? { ...item, ...posePatch } : item)
        : slot.subjects,
      props: action.entityKind === "prop"
        ? slot.props.map((item) => item.id === action.entityId ? { ...item, ...posePatch } : item)
        : slot.props,
    };
    const nextPacket = {
      ...packetRef.current,
      slots: packetRef.current.slots.map((item) => item.shot_id === nextSlot.shot_id ? nextSlot : item),
    };
    replacePacket(nextPacket);
    activeShotIdRef.current = nextSlot.shot_id;
    setActiveShotId(nextSlot.shot_id);
    runtimeRef.current?.applySlot(nextSlot);
    setSelected(runtimeRef.current?.selectEntity(`${action.entityKind}:${action.entityId}`) ?? null);
    completeAgentAction();
  }, [allowBelowGround, completeAgentAction, open, pendingAgentAction, replacePacket, selectShot, showToast]);

  const addActor = () => {
    if (!activeSlot) return;
    if (activeSlot.subjects.length >= 12) {
      showToast("单个镜头最多放置 12 个人物", "error");
      return;
    }
    const id = nextEntityId("actor", activeSlot);
    const position = nextEntityPosition(activeSlot.subjects.length + activeSlot.props.length);
    const actor: DirectorStageActorPose = {
      id,
      label: `人物 ${activeSlot.subjects.length + 1}`,
      x: position.x,
      y: 0,
      z: position.z,
      rotation_y: 0,
      scale: 1,
      action: "待调度",
    };
    commitActiveSlot({ ...activeSlot, subjects: [...activeSlot.subjects, actor] }, `actor:${id}`);
  };

  const addProp = (label: string) => {
    if (!activeSlot) return;
    if (activeSlot.props.length >= 20) {
      showToast("单个镜头最多放置 20 个道具", "error");
      return;
    }
    const id = nextEntityId("prop", activeSlot);
    const position = nextEntityPosition(activeSlot.subjects.length + activeSlot.props.length);
    const prop: DirectorStagePropPose = {
      id,
      label,
      x: position.x,
      y: 0,
      z: position.z,
      rotation_y: 0,
      scale: 1,
    };
    commitActiveSlot({ ...activeSlot, props: [...activeSlot.props, prop] }, `prop:${id}`);
    setPropMenuOpen(false);
  };

  const duplicateSelected = () => {
    if (!activeSlot || !selected) return;
    const sourceId = selected.id.replace(/^(actor|prop):/, "");
    if (selected.kind === "actor") {
      const source = activeSlot.subjects.find((item) => item.id === sourceId);
      if (!source || activeSlot.subjects.length >= 12) return;
      const id = nextEntityId("actor", activeSlot);
      const actor = { ...source, id, label: `${source.label} 复制`, x: source.x + 0.65, z: source.z + 0.35 };
      commitActiveSlot({ ...activeSlot, subjects: [...activeSlot.subjects, actor] }, `actor:${id}`);
    } else {
      const source = activeSlot.props.find((item) => item.id === sourceId);
      if (!source || activeSlot.props.length >= 20) return;
      const id = nextEntityId("prop", activeSlot);
      const prop = { ...source, id, label: `${source.label} 复制`, x: source.x + 0.65, z: source.z + 0.35 };
      commitActiveSlot({ ...activeSlot, props: [...activeSlot.props, prop] }, `prop:${id}`);
    }
  };

  const removeSelected = () => {
    if (!activeSlot || !selected) return;
    const sourceId = selected.id.replace(/^(actor|prop):/, "");
    commitActiveSlot({
      ...activeSlot,
      subjects: selected.kind === "actor" ? activeSlot.subjects.filter((item) => item.id !== sourceId) : activeSlot.subjects,
      props: selected.kind === "prop" ? activeSlot.props.filter((item) => item.id !== sourceId) : activeSlot.props,
    });
  };

  const moveShot = (offset: number) => {
    const nextIndex = Math.min(packet.slots.length - 1, Math.max(0, activeShotIndex + offset));
    const slot = packet.slots[nextIndex];
    if (slot && nextIndex !== activeShotIndex) selectShot(slot.shot_id);
  };

  const moveBatch = (offset: number) => {
    const nextBatch = Math.min(totalBatches - 1, Math.max(0, activeBatchIndex + offset));
    const target = packet.slots[nextBatch * DIRECTOR_STAGE_PREVIEW_BATCH_SIZE];
    if (target) selectShot(target.shot_id);
  };

  const captureSlots = async (slots: DirectorStageSlot[]) => {
    if (!slots.length || capturing) return;
    setCapturing(true);
    setCaptureProgress({ current: 0, total: slots.length });
    const restoreId = activeShotIdRef.current;
    try {
      const runtime = runtimeRef.current;
      if (!runtime) throw new Error("导演台还未准备完成");
      const captures: DirectorStageCapture[] = [];
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index]!;
        setCaptureProgress({ current: index + 1, total: slots.length });
        runtime.applySlot(slot);
        await settleFrames(2);
        captures.push(runtime.capture(slot));
      }
      await onCapture(captures);
      showToast(`${captures.length} 个分镜截图已加入画布`, "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "截图失败，请稍后重试", "error");
    } finally {
      const restoreSlot = packetRef.current.slots.find((slot) => slot.shot_id === restoreId) ?? firstSlot(packetRef.current);
      runtimeRef.current?.applySlot(restoreSlot);
      setCapturing(false);
      setCaptureProgress({ current: 0, total: 0 });
    }
  };

  const importPacket = async (file?: File) => {
    if (!file) return;
    try {
      const normalized = normalizeDirectorStagePacket(JSON.parse(await file.text()));
      const next = allowBelowGround ? normalized : groundPacket(normalized);
      const initialSlot = firstSlot(next);
      replacePacket(next);
      activeShotIdRef.current = initialSlot.shot_id;
      setActiveShotId(activeShotIdRef.current);
      setSelected(null);
      runtimeRef.current?.applySlot(initialSlot);
      showToast("分镜包已载入导演台", "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "分镜包格式不正确", "error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const exportPacket = () => {
    const blob = new Blob([JSON.stringify(packetRef.current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kachang-director-stage.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const toggleGroundLock = () => {
    const nextAllowed = !allowBelowGround;
    setAllowBelowGround(nextAllowed);
    if (nextAllowed) return;
    const next = groundPacket(packetRef.current);
    replacePacket(next);
    const nextSlot = next.slots.find((slot) => slot.shot_id === activeShotIdRef.current) ?? firstSlot(next);
    runtimeRef.current?.applySlot(nextSlot);
    setSelected(selected ? runtimeRef.current?.selectEntity(selected.id) ?? null : null);
    showToast("低于地面的对象已回到地面", "info");
  };

  if (!open) return null;

  return (
    <section className="kc-director-stage" role="dialog" aria-label="3D 导演台" aria-modal="true">
      <canvas
        ref={canvasRef}
        className={`kc-director-canvas ${draggingEntity ? "is-dragging-entity" : ""}`}
        data-testid="director-stage-canvas"
      />

      <header className="kc-director-header">
        <div className="kc-director-title">
          <span className="kc-director-mark"><Clapperboard aria-hidden="true" /></span>
          <span><strong>3D 导演台</strong><small>{packet.global_visual_contract || "分镜预演空间"}</small></span>
        </div>
        <div className="kc-director-header-actions">
          <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importPacket(event.target.files?.[0])} />
          <StageIconButton label="导入分镜包" onClick={() => fileRef.current?.click()}><FileJson /></StageIconButton>
          <StageIconButton label="导出分镜包" onClick={exportPacket}><Download /></StageIconButton>
          <StageIconButton label="恢复当前镜头" onClick={() => activeSlot && runtimeRef.current?.applySlot(activeSlot)}><RotateCcw /></StageIconButton>
          <button className="kc-director-command" type="button" disabled={!activeSlot || capturing} onClick={() => activeSlot && void captureSlots([activeSlot])}>
            <ImagePlus aria-hidden="true" /><span>截取当前</span>
          </button>
          <button className="kc-director-command is-primary" type="button" disabled={!activeBatchSlots.length || capturing} onClick={() => void captureSlots(activeBatchSlots)}>
            <Images aria-hidden="true" /><span>{capturing ? `${captureProgress.current}/${captureProgress.total}` : "本批截图"}</span>
          </button>
          <StageIconButton label="关闭导演台" onClick={onClose}><X /></StageIconButton>
        </div>
      </header>

      <aside className="kc-director-shots" aria-label="镜头列表">
        <div className="kc-director-panel-heading">
          <span>镜头</span><small>{activeShotIndex + 1} / {packet.slots.length}</small>
        </div>
        <div className="kc-director-shot-list">
          {packet.slots.map((slot) => (
            <button
              type="button"
              key={slot.shot_id}
              className={slot.shot_id === activeSlot?.shot_id ? "is-active" : ""}
              onClick={() => selectShot(slot.shot_id)}
            >
              <span>{String(slot.slot).padStart(2, "0")}</span>
              <span><strong>{slot.dramatic_function}</strong><small>{slot.camera.shot_size} · {slot.duration_max}s</small></span>
            </button>
          ))}
        </div>
        {totalBatches > 1 ? (
          <div className="kc-director-batch-nav">
            <StageIconButton label="上一批" disabled={activeBatchIndex === 0} onClick={() => moveBatch(-1)}><ChevronLeft /></StageIconButton>
            <span>{activeBatchIndex + 1} / {totalBatches}</span>
            <StageIconButton label="下一批" disabled={activeBatchIndex >= totalBatches - 1} onClick={() => moveBatch(1)}><ChevronRight /></StageIconButton>
          </div>
        ) : null}
      </aside>

      {activeSlot ? (
        <div className="kc-director-shot-caption">
          <small>镜头 {String(activeSlot.slot).padStart(2, "0")} · {activeSlot.camera.shot_size} · {activeSlot.camera.angle}</small>
          <strong>{activeSlot.dramatic_function}</strong>
          {activeSlot.beat ? <span>{activeSlot.beat}</span> : null}
        </div>
      ) : null}

      <aside className="kc-director-inspector" aria-label="场面调度">
        <div className="kc-director-panel-heading"><span>场面调度</span><small>{activeSlot?.unit_id}</small></div>
        <div className="kc-director-add-row">
          <button type="button" onClick={addActor}><UserPlus aria-hidden="true" />人物</button>
          <div className="kc-director-prop-picker">
            <button type="button" aria-expanded={propMenuOpen} onClick={() => setPropMenuOpen((value) => !value)}><PackagePlus aria-hidden="true" />道具</button>
            {propMenuOpen ? (
              <div className="kc-director-prop-menu" role="menu">
                {PROP_OPTIONS.map((label) => <button type="button" role="menuitem" key={label} onClick={() => addProp(label)}>{label}</button>)}
              </div>
            ) : null}
          </div>
        </div>

        <div className="kc-director-entity-list">
          {activeSlot?.subjects.map((actor) => (
            <EntityButton
              key={`actor:${actor.id}`}
              label={actor.label}
              detail={actor.action || "人物"}
              selected={selected?.id === `actor:${actor.id}`}
              onClick={() => setSelected(runtimeRef.current?.selectEntity(`actor:${actor.id}`) ?? null)}
            />
          ))}
          {activeSlot?.props.map((prop) => (
            <EntityButton
              key={`prop:${prop.id}`}
              label={prop.label}
              detail="道具"
              selected={selected?.id === `prop:${prop.id}`}
              onClick={() => setSelected(runtimeRef.current?.selectEntity(`prop:${prop.id}`) ?? null)}
            />
          ))}
          {!activeSlot?.subjects.length && !activeSlot?.props.length ? <p>当前镜头还没有对象</p> : null}
        </div>

        <div className="kc-director-inspector-scroll">
          {selected ? (
            <>
              <div className="kc-director-selection-title">
                <span><small>{selected.kind === "actor" ? "人物" : "道具"}</small><strong>{selected.label}</strong></span>
                <span>
                  <StageIconButton label="复制对象" onClick={duplicateSelected}><CopyPlus /></StageIconButton>
                  <StageIconButton label="删除对象" danger onClick={removeSelected}><Trash2 /></StageIconButton>
                </span>
              </div>
              <StageRange label="左右 X" value={selected.x} min={-20} max={20} step={0.1} onChange={(x) => updateSelected({ x })} />
              <StageRange
                label="高度 Y"
                value={selected.y}
                min={-2}
                max={10}
                step={0.05}
                softFloor={allowBelowGround ? undefined : 0}
                onSoftFloorBlocked={() => showToast("已在地面停止；开启“允许地下”后可继续下移", "info")}
                onChange={(y) => updateSelected({ y })}
              />
              <StageRange label="前后 Z" value={selected.z} min={-20} max={20} step={0.1} onChange={(z) => updateSelected({ z })} />
              <StageRange label="朝向" value={selected.rotationY} min={-180} max={180} step={1} suffix="°" onChange={(rotationY) => updateSelected({ rotationY })} />
              <StageRange label="缩放" value={selected.scale} min={0.2} max={5} step={0.05} onChange={(scale) => updateSelected({ scale })} />
              <button type="button" className={`kc-director-ground-toggle ${allowBelowGround ? "is-unlocked" : ""}`} onClick={toggleGroundLock}>
                {allowBelowGround ? <UnlockKeyhole aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
                <span><strong>{allowBelowGround ? "允许地下" : "地面锁定"}</strong><small>{allowBelowGround ? "Y 轴可低于 0" : "对象会在地面停止"}</small></span>
              </button>
            </>
          ) : (
            <div className="kc-director-empty-selection"><Focus aria-hidden="true" /><span>选择人物或道具后调整位置</span></div>
          )}
        </div>
      </aside>

      <div className="kc-director-camera-strip">
        <Camera aria-hidden="true" />
        <span>{activeSlot?.camera.shot_size || "中景"}</span>
        <span>{activeSlot?.camera.angle || "平视"}</span>
        <span>{activeSlot?.camera.movement || "固定"}</span>
        <span>FOV {Math.round(activeSlot?.camera.fov || 38)}°</span>
      </div>

      <div className="kc-director-shot-nav">
        <StageIconButton label="上一个镜头" disabled={activeShotIndex === 0} onClick={() => moveShot(-1)}><ChevronLeft /></StageIconButton>
        <span>{String(activeShotIndex + 1).padStart(2, "0")}</span>
        <StageIconButton label="下一个镜头" disabled={activeShotIndex >= packet.slots.length - 1} onClick={() => moveShot(1)}><ChevronRight /></StageIconButton>
      </div>
    </section>
  );
}

function stageStorageKey(projectId: string) {
  return `kachang-canvas:director-stage:v1:${projectId}`;
}

function readPersistedStage(projectId: string, initialPacket: DirectorStagePacket | null): PersistedStage {
  if (initialPacket) {
    return { packet: groundPacket(normalizeDirectorStagePacket(initialPacket)), allowBelowGround: false };
  }
  try {
    const raw = window.localStorage.getItem(stageStorageKey(projectId));
    if (raw) {
      const value = JSON.parse(raw) as Partial<PersistedStage>;
      const allowBelowGround = value.allowBelowGround === true;
      const packet = normalizeDirectorStagePacket(value.packet);
      return { packet: allowBelowGround ? packet : groundPacket(packet), allowBelowGround };
    }
  } catch {
    window.localStorage.removeItem(stageStorageKey(projectId));
  }
  return { packet: createDirectorStageStarterPacket(), allowBelowGround: false };
}

function groundPacket(packet: DirectorStagePacket): DirectorStagePacket {
  return {
    ...packet,
    slots: packet.slots.map((slot) => ({
      ...slot,
      subjects: slot.subjects.map((item) => item.y < 0 ? { ...item, y: 0 } : item),
      props: slot.props.map((item) => item.y < 0 ? { ...item, y: 0 } : item),
    })),
  };
}

function nextEntityId(kind: "actor" | "prop", slot: DirectorStageSlot) {
  const used = new Set((kind === "actor" ? slot.subjects : slot.props).map((item) => item.id));
  for (let index = 1; index < 100; index += 1) {
    const id = `${kind}-${index}`;
    if (!used.has(id)) return id;
  }
  return `${kind}-${Date.now().toString(36)}`;
}

function nextEntityPosition(index: number) {
  const positions = [
    { x: -1.4, z: 0 }, { x: 1.4, z: 0 }, { x: 0, z: 1.35 }, { x: 0, z: -1.35 },
    { x: -1.4, z: 1.35 }, { x: 1.4, z: 1.35 }, { x: -1.4, z: -1.35 }, { x: 1.4, z: -1.35 },
  ];
  const base = positions[index % positions.length]!;
  const ring = Math.floor(index / positions.length);
  return { x: base.x + ring * 0.45, z: base.z + ring * 0.45 };
}

function firstSlot(packet: DirectorStagePacket) {
  const slot = packet.slots[0];
  if (!slot) throw new Error("导演台分镜包至少需要一个镜头");
  return slot;
}

function StageIconButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`kc-director-icon-button ${danger ? "is-danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EntityButton({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={selected ? "is-selected" : ""} aria-label={label} onClick={onClick}>
      <span>{label}</span><small>{detail}</small>
    </button>
  );
}

function StageRange({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  softFloor,
  onSoftFloorBlocked,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  softFloor?: number;
  onSoftFloorBlocked?: () => void;
  onChange: (value: number) => void;
}) {
  const precision = Math.max(0, (String(step).split(".")[1] || "").length);
  const format = (next: number) => next.toFixed(precision);
  const [draft, setDraft] = useState(format(value));

  useEffect(() => setDraft(format(value)), [precision, value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    const snapped = Number((Math.round(clamped / step) * step).toFixed(precision));
    const applied = softFloor !== undefined && snapped < softFloor ? softFloor : snapped;
    if (applied !== snapped) onSoftFloorBlocked?.();
    onChange(applied);
    setDraft(format(applied));
  };

  const changeRange = (next: number) => {
    if (softFloor !== undefined && next < softFloor) {
      onSoftFloorBlocked?.();
      onChange(softFloor);
      return;
    }
    onChange(next);
  };

  return (
    <label className="kc-director-range">
      <span><span>{label}</span><span><input aria-label={`${label}精确数值`} type="number" value={draft} min={min} max={max} step={step} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(format(value)); event.currentTarget.blur(); }
      }} />{suffix}</span></span>
      <input
        type="range"
        value={Math.min(max, Math.max(min, value))}
        min={min}
        max={max}
        step={step}
        style={{ "--kc-range-progress": `${max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0}%` } as CSSProperties}
        onChange={(event) => changeRange(Number(event.target.value))}
      />
    </label>
  );
}

function settleFrames(count: number) {
  return new Promise<void>((resolve) => {
    const step = (left: number) => requestAnimationFrame(() => left <= 1 ? resolve() : step(left - 1));
    step(Math.max(1, count));
  });
}
