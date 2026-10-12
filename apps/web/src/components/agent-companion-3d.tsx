import { memo, useEffect, useRef } from "react";
import * as THREE from "three";

type CompanionReaction = "idle" | "curious" | "celebrate" | "concerned" | "thinking" | "listening";

/**
 * A lightweight 3D companion rendered with three.js: a rounded robot head with
 * soft studio lighting that tracks the pointer, blinks, and reacts to agent
 * activity. Runs on its own rAF loop and stays on the GPU; nothing here forces
 * layout so the canvas keeps its frame budget.
 */
export const AgentCompanion3D = memo(function AgentCompanion3D({
  reaction,
  activity,
}: {
  reaction: CompanionReaction;
  activity: "idle" | "working" | "error" | "open";
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef({ reaction, activity });
  stateRef.current = { reaction, activity };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const width = host.clientWidth || 72;
    const height = host.clientHeight || 72;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 50);
    camera.position.set(0, 0.1, 5.2);

    // Lighting: a soft key + cool rim + warm fill for a premium matte look.
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.5, 3.5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x86b6ff, 0.7);
    rim.position.set(-3, 1.5, -2);
    scene.add(rim);
    const fill = new THREE.PointLight(0xffe6c4, 0.5, 20);
    fill.position.set(0, -2, 3);
    scene.add(fill);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xf2f3f5,
      roughness: 0.42,
      metalness: 0.08,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1c1e22,
      roughness: 0.5,
      metalness: 0.2,
    });
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff,
      emissive: 0x4aa8e8,
      emissiveIntensity: 1.1,
      roughness: 0.3,
      metalness: 0,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x2a6df0,
      emissive: 0x2a6df0,
      emissiveIntensity: 0.35,
      roughness: 0.4,
      metalness: 0.1,
    });

    const root = new THREE.Group();
    scene.add(root);
    const head = new THREE.Group();
    root.add(head);

    // Body / head: a smooth rounded capsule-like sphere.
    const skullGeo = new THREE.SphereGeometry(1.05, 48, 48);
    const skull = new THREE.Mesh(skullGeo, bodyMat);
    skull.scale.set(1, 0.92, 0.92);
    head.add(skull);

    // Face visor (dark glass panel).
    const visorGeo = new THREE.SphereGeometry(
      0.86,
      40,
      40,
      Math.PI * 0.16,
      Math.PI * 0.68,
      Math.PI * 0.3,
      Math.PI * 0.42,
    );
    const visor = new THREE.Mesh(visorGeo, darkMat);
    visor.position.set(0, 0.04, 0.34);
    visor.scale.set(1, 0.86, 0.82);
    head.add(visor);

    // Eyes (large expressive emissive capsules that blink via scale).
    const eyeGeo = new THREE.CapsuleGeometry(0.14, 0.2, 8, 20);
    const eyeL = new THREE.Mesh(eyeGeo, glowMat);
    eyeL.position.set(-0.34, 0.12, 0.9);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.34;
    head.add(eyeL, eyeR);

    // Eye highlights for a lively look.
    const highlightGeo = new THREE.SphereGeometry(0.045, 12, 12);
    const highlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const hlL = new THREE.Mesh(highlightGeo, highlightMat);
    hlL.position.set(-0.31, 0.2, 0.98);
    const hlR = hlL.clone();
    hlR.position.x = 0.37;
    head.add(hlL, hlR);

    // Cheek lights.
    const cheekGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const cheekMat = new THREE.MeshStandardMaterial({
      color: 0xffb3c4,
      emissive: 0xff8fa8,
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    const cheekL = new THREE.Mesh(cheekGeo, cheekMat);
    cheekL.position.set(-0.52, -0.16, 0.78);
    const cheekR = cheekL.clone();
    cheekR.position.x = 0.52;
    head.add(cheekL, cheekR);

    // Antenna with a glowing tip (pulses with activity).
    const antennaGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.5, 12);
    const antenna = new THREE.Mesh(antennaGeo, darkMat);
    antenna.position.set(0, 1.2, 0);
    head.add(antenna);
    const antennaTipGeo = new THREE.SphereGeometry(0.11, 20, 20);
    const antennaTip = new THREE.Mesh(antennaTipGeo, accentMat);
    antennaTip.position.set(0, 1.5, 0);
    head.add(antennaTip);

    // Ear pods.
    const earGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.16, 24);
    const earL = new THREE.Mesh(earGeo, bodyMat);
    earL.rotation.z = Math.PI / 2;
    earL.position.set(-1.02, 0.1, 0);
    const earR = earL.clone();
    earR.position.x = 1.02;
    head.add(earL, earR);
    const earDotGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.18, 16);
    const earDotL = new THREE.Mesh(earDotGeo, glowMat);
    earDotL.rotation.z = Math.PI / 2;
    earDotL.position.set(-1.05, 0.1, 0);
    const earDotR = earDotL.clone();
    earDotR.position.x = 1.05;
    head.add(earDotL, earDotR);

    // Pointer tracking (normalized -1..1).
    // 缓存宿主矩形：pointermove 里直接 getBoundingClientRect 会强制同步 layout，
    // 而 layout 成本随画布 DOM 规模上升，节点变多时鼠标移动会被明显拖慢。
    const pointer = { x: 0, y: 0 };
    let hostRect = host.getBoundingClientRect();
    const refreshHostRect = () => {
      hostRect = host.getBoundingClientRect();
    };
    const rectObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(refreshHostRect) : null;
    rectObserver?.observe(host);
    window.addEventListener("resize", refreshHostRect, { passive: true });
    window.addEventListener("scroll", refreshHostRect, { passive: true, capture: true });
    const onPointer = (event: PointerEvent) => {
      pointer.x = ((event.clientX - hostRect.left) / Math.max(1, hostRect.width)) * 2 - 1;
      pointer.y = -(((event.clientY - hostRect.top) / Math.max(1, hostRect.height)) * 2 - 1);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let raf = 0;
    let running = true;
    const clock = new THREE.Clock();
    let blinkTimer = 1.6 + Math.random() * 2.4;
    let blinkPhase = 0;

    // Pause the render loop when the page is hidden or the companion scrolls out
    // of view so it never burns GPU when it isn't visible.
    const visibilityObserver =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            ([entry]) => {
              running = Boolean(entry?.isIntersecting) && !document.hidden;
              // 重新进入视口时布局可能已经变化，同步刷新缓存的矩形。
              if (running) refreshHostRect();
            },
            { threshold: 0.05 },
          )
        : null;
    visibilityObserver?.observe(host);
    const onVisibility = () => {
      running = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);

    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (!running) return;
      const t = clock.getElapsedTime();
      const { reaction: currentReaction, activity: currentActivity } = stateRef.current;

      // Idle bob + reaction-specific motion.
      const bobSpeed = currentActivity === "working" ? 3.4 : 1.6;
      const bobAmp =
        currentReaction === "celebrate" ? 0.12 : currentActivity === "working" ? 0.05 : 0.07;
      head.position.y = Math.sin(t * bobSpeed) * bobAmp;

      // Head gently tracks the pointer.
      const targetY = pointer.x * 0.5;
      const targetX = -pointer.y * 0.32;
      head.rotation.y += (targetY - head.rotation.y) * 0.08;
      head.rotation.x += (targetX - head.rotation.x) * 0.08;
      head.rotation.z = Math.sin(t * 0.6) * 0.02 + (currentReaction === "curious" ? 0.12 : 0);

      // Blinking.
      blinkTimer -= 0.016;
      if (blinkTimer <= 0) {
        blinkTimer = 1.8 + Math.random() * 2.6;
        blinkPhase = 0.18;
      }
      if (blinkPhase > 0) {
        blinkPhase -= 0.016;
        const k = Math.max(0, Math.min(1, blinkPhase / 0.18));
        const scaleY = 0.1 + 0.9 * Math.abs(Math.cos(k * Math.PI));
        eyeL.scale.y = scaleY;
        eyeR.scale.y = scaleY;
      } else {
        eyeL.scale.y = 1;
        eyeR.scale.y = 1;
      }

      // Thinking: eyes look around; concerned: eyes droop; celebrate: antenna glow.
      const lookX = currentReaction === "thinking" ? Math.sin(t * 1.8) * 0.06 : 0;
      eyeL.position.x = -0.34 + lookX;
      eyeR.position.x = 0.34 + lookX;
      const eyeY =
        currentReaction === "concerned" ? 0.02 : currentReaction === "celebrate" ? 0.16 : 0.1;
      eyeL.position.y += (eyeY - eyeL.position.y) * 0.1;
      eyeR.position.y += (eyeY - eyeR.position.y) * 0.1;

      const pulse =
        currentActivity === "working"
          ? 0.5 + Math.abs(Math.sin(t * 5))
          : currentActivity === "error"
            ? 0.8
            : 0.35;
      accentMat.emissiveIntensity = pulse;
      if (currentActivity === "error") {
        accentMat.color.set(0xe04b3a);
        accentMat.emissive.set(0xe04b3a);
      } else {
        accentMat.color.set(0x2a6df0);
        accentMat.emissive.set(0x2a6df0);
      }

      antennaTip.scale.setScalar(
        1 + (currentActivity === "working" ? Math.abs(Math.sin(t * 5)) * 0.25 : 0),
      );

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      visibilityObserver?.disconnect();
      rectObserver?.disconnect();
      window.removeEventListener("resize", refreshHostRect);
      window.removeEventListener("scroll", refreshHostRect, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      renderer.dispose();
      skullGeo.dispose();
      visorGeo.dispose();
      antennaGeo.dispose();
      antennaTipGeo.dispose();
      eyeGeo.dispose();
      cheekGeo.dispose();
      earGeo.dispose();
      earDotGeo.dispose();
      highlightGeo.dispose();
      highlightMat.dispose();
      cheekMat.dispose();
      bodyMat.dispose();
      darkMat.dispose();
      glowMat.dispose();
      accentMat.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <span ref={hostRef} className="wc-agent-companion-3d" aria-hidden="true" />;
});
