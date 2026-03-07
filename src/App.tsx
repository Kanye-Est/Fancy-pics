import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Hands, Results } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import gsap from 'gsap';

// --- Helper: Create Texture Atlas for Particles ---
const createAtlasTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Clear background (transparent)
  ctx.clearRect(0, 0, 512, 512);

  // Draw crisp white symbols instead of emojis to avoid platform color/alpha issues
  ctx.fillStyle = '#ffffff';
  ctx.font = '120px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 0: Star
  ctx.fillText('★', 128, 128);
  // 1: Circle
  ctx.fillText('●', 384, 128);
  // 2: Sparkle
  ctx.fillText('✦', 128, 384);
  // 3: Flower/Shell-like
  ctx.fillText('✿', 384, 384);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
};

// --- Shaders ---
const shellVertexShader = `
  attribute vec3 targetPos;
  attribute float randomOffset;
  attribute float shapeIndex;
  attribute float surfaceV;
  
  uniform float time;
  uniform float scatterProgress;
  
  varying vec2 vUv;
  varying float vScatter;
  varying float vShapeIndex;
  varying float vSurfaceV;
  
  void main() {
    vUv = uv;
    vScatter = scatterProgress;
    vShapeIndex = shapeIndex;
    vSurfaceV = surfaceV;
    
    vec4 basePos = instanceMatrix * vec4(position, 1.0);
    
    vec3 scatteredPos = targetPos;
    scatteredPos.y += sin(time * 1.0 + randomOffset) * 2.0;
    scatteredPos.x += cos(time * 0.8 + randomOffset) * 2.0;
    scatteredPos.z += sin(time * 0.9 + randomOffset) * 2.0;
    
    vec3 finalPos = mix(basePos.xyz, scatteredPos, scatterProgress);
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(finalPos, 1.0);
  }
`;

const shellFragmentShader = `
  uniform sampler2D atlas;
  varying vec2 vUv;
  varying float vScatter;
  varying float vShapeIndex;
  varying float vSurfaceV;
  
  void main() {
    // Calculate UV for 2x2 atlas
    float col = mod(vShapeIndex, 2.0);
    float row = floor(vShapeIndex / 2.0);
    vec2 atlasUv = (vUv * 0.5) + vec2(col * 0.5, 0.5 - row * 0.5);
    
    vec4 texColor = texture2D(atlas, atlasUv);
    if (texColor.a < 0.1) discard;
    
    // Warm glowing color matching the reference image
    // Use vSurfaceV to control the gradient of the shell
    vec3 color = mix(vec3(1.0, 0.95, 0.8), vec3(1.0, 0.7, 0.4), vSurfaceV);
    
    // Make edges brighter
    float edgeGlow = pow(vSurfaceV, 2.0);
    color += vec3(1.0, 0.8, 0.5) * edgeGlow * 0.8;
    
    // Also use vScatter to reduce alpha when scattered
    float alpha = mix(0.8 + edgeGlow * 0.4, 0.3, vScatter) * texColor.a;
    
    gl_FragColor = vec4(color, alpha);
  }
`;

// --- Helper: Create Solid Shell Geometry ---
// (Removed as we are using particle outline now)

// --- Main Component ---
export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [gesture, setGesture] = useState<string>('UNKNOWN');
  const [photos, setPhotos] = useState<string[]>([]);
  const processedPhotosCount = useRef(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  
  // Three.js refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  
  const upperShellRef = useRef<THREE.InstancedMesh | null>(null);
  const lowerShellRef = useRef<THREE.InstancedMesh | null>(null);
  const pearlRef = useRef<THREE.Mesh | null>(null);
  const photoGroupRef = useRef<THREE.Group | null>(null);
  const shellGroupRef = useRef<THREE.Group | null>(null);
  const targetShellRotationRef = useRef({ x: 0, y: 0 });
  const targetShellPositionRef = useRef({ x: 0, y: 0, z: 0 });
  const handPositionRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const gestureBufferRef = useRef<string[]>([]);
  const stableGestureRef = useRef<string>('UNKNOWN');
  const GESTURE_STABILITY_FRAMES = 5;

  // Debug refs
  const rawGestureRef = useRef<string>('UNKNOWN');
  const landmark9Ref = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastDebugLogRef = useRef<number>(0);
  const [debugInfo, setDebugInfo] = useState({
    rawGesture: 'UNKNOWN',
    stableGesture: 'UNKNOWN',
    landmark9: { x: 0, y: 0 },
    targetPos: { x: 0, y: 0, z: 0 },
    shellPos: { x: 0, y: 0, z: 0 },
  });

  const stateRef = useRef({
    currentState: 'CLOSED',
    scatterProgress: 0,
    shellOpenAngle: 0,
    bloomIntensity: 0.2,
    time: 0
  });
  
  const isAnimatingCameraRef = useRef(false);
  const currentZoomIndexRef = useRef(0);
  const zoomedPhotoDataRef = useRef<{
    mesh: THREE.Mesh;
    originalPosition: THREE.Vector3;
    originalQuaternion: THREE.Quaternion;
  } | null>(null);

  // Initialize Three.js
  useEffect(() => {
    if (!mountRef.current) return;
    
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    
    const scene = new THREE.Scene();
    // Warm orange/amber background matching the reference image
    scene.background = new THREE.Color(0xd48a56);
    scene.fog = new THREE.FogExp2(0xd48a56, 0.015);
    sceneRef.current = scene;
    
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(0, 0, 40); // Moved back to see the whole shell clearly
    cameraRef.current = camera;
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;
    
    // Post-processing - Soft bloom for the glowing lines
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.4, 0.5, 0.85);
    bloomPass.threshold = 0.5; // Higher threshold so only bright things bloom
    bloomPass.strength = 0.4;  // Lower strength to avoid whiteout
    bloomPass.radius = 0.5;
    
    const composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);
    composerRef.current = composer;
    
    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffeedd, 1);
    dirLight.position.set(5, 10, 5);
    scene.add(dirLight);
    
    // --- Create Shell Group ---
    const shellGroup = new THREE.Group();
    scene.add(shellGroup);
    shellGroupRef.current = shellGroup;
    
    // --- Create Pearl ---
    const pearlGeo = new THREE.SphereGeometry(1.5, 64, 64);
    const pearlMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff5ee, // Seashell white
      emissive: 0x22110a, // Slight warm glow
      roughness: 0.1, // Very smooth
      metalness: 0.1, // Slightly metallic for luster
      clearcoat: 1.0, // High clearcoat for that glossy pearl look
      clearcoatRoughness: 0.1,
      iridescence: 1.0, // Iridescence is perfect for pearls!
      iridescenceIOR: 1.5,
      iridescenceThicknessRange: [100, 400],
      transparent: true,
      opacity: 1,
    });
    const pearl = new THREE.Mesh(pearlGeo, pearlMat);
    pearl.position.set(0, -2, 0);
    shellGroup.add(pearl);
    pearlRef.current = pearl;
    
    // Add a warm point light inside the pearl
    const pearlLight = new THREE.PointLight(0xffaa55, 2, 20);
    pearlLight.position.copy(pearl.position);
    shellGroup.add(pearlLight);
    
    // Store refs for animation
    const pearlLightRef = { current: pearlLight };
    const pearlMatRef = { current: pearlMat };
    
    // --- Create Shells (Line Art Scallop) ---
    const particleCount = 8000; // Increased density for a better outline
    const scaleGeo = new THREE.PlaneGeometry(0.15, 0.15); // Smaller particles
    
    const atlasTex = createAtlasTexture();
    
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: shellVertexShader,
      fragmentShader: shellFragmentShader,
      uniforms: {
        time: { value: 0 },
        scatterProgress: { value: 0 },
        atlas: { value: atlasTex }
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
    
    const createShellHalf = (isUpper: boolean) => {
      const instancedMesh = new THREE.InstancedMesh(scaleGeo, shellMat, particleCount);
      const dummy = new THREE.Object3D();
      
      const targetPosArray = new Float32Array(particleCount * 3);
      const randomOffsetArray = new Float32Array(particleCount);
      const shapeIndexArray = new Float32Array(particleCount);
      const surfaceVArray = new Float32Array(particleCount);
      
      const numRibs = 13;
      const thetaMax = Math.PI * 0.4;
      
      for (let i = 0; i < particleCount; i++) {
        let u = Math.random();
        let v = Math.random();
        
        // Structure the particles to form a shell
        const type = Math.random();
        if (type < 0.5) {
          // Ribs (Radiating lines) - snap to nearest rib
          const ribU = u * (numRibs - 1);
          u = (Math.floor(ribU + 0.5) + (Math.random() - 0.5) * 0.15) / (numRibs - 1);
          u = Math.max(0, Math.min(1, u));
        } else if (type < 0.7) {
          // Edges (Scalloped arcs)
          v = 1.0 - Math.pow(Math.random(), 4.0);
        } else if (type < 0.8) {
          // Hinge area
          v = Math.pow(Math.random(), 4.0);
        }
        // The rest (20%) are randomly scattered on the surface
        
        const theta = -thetaMax + u * (2 * thetaMax);
        const L = 14 + 2 * Math.cos(theta);
        
        const exactRibU = u * (numRibs - 1);
        const exactRibFraction = exactRibU - Math.floor(exactRibU);
        const bulge = Math.sin(exactRibFraction * Math.PI) * 1.2 * v;
        
        const R = v * L + bulge;
        
        const taper = Math.pow(Math.sin(u * Math.PI), 0.5);
        let z = Math.sin(v * Math.PI) * taper * 3.5;
        
        let x = R * Math.sin(theta);
        let y = -6 + R * Math.cos(theta);
        
        // Add slight noise to make the lines look organic and glowing
        x += (Math.random() - 0.5) * 0.3;
        y += (Math.random() - 0.5) * 0.3;
        z += (Math.random() - 0.5) * 0.3;
        
        if (!isUpper) {
          z = -z;
        }
        
        dummy.position.set(x, y, z);
        dummy.lookAt(x * 2, y * 2, z * 2 + (isUpper ? 10 : -10));
        dummy.rotateZ(Math.random() * Math.PI * 2); // Random spin for icons
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(i, dummy.matrix);
        
        // Scattered target positions
        targetPosArray[i * 3] = (Math.random() - 0.5) * 60;
        targetPosArray[i * 3 + 1] = (Math.random() - 0.5) * 60;
        targetPosArray[i * 3 + 2] = (Math.random() - 0.5) * 60;
        
        randomOffsetArray[i] = Math.random() * Math.PI * 2;
        shapeIndexArray[i] = Math.floor(Math.random() * 4); // 0,1,2,3
        surfaceVArray[i] = v;
      }
      
      instancedMesh.geometry.setAttribute('targetPos', new THREE.InstancedBufferAttribute(targetPosArray, 3));
      instancedMesh.geometry.setAttribute('randomOffset', new THREE.InstancedBufferAttribute(randomOffsetArray, 1));
      instancedMesh.geometry.setAttribute('shapeIndex', new THREE.InstancedBufferAttribute(shapeIndexArray, 1));
      instancedMesh.geometry.setAttribute('surfaceV', new THREE.InstancedBufferAttribute(surfaceVArray, 1));
      
      // Pivot for both shells so they can rotate around the hinge
      instancedMesh.position.set(0, 0, 0);
      for (let i = 0; i < particleCount; i++) {
        instancedMesh.getMatrixAt(i, dummy.matrix);
        dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
        // Shift relative to hinge (0, -6, 0)
        dummy.position.y -= -6;
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(i, dummy.matrix);
      }
      instancedMesh.position.y = -6;
      
      return instancedMesh;
    };
    
    const upperShell = createShellHalf(true);
    const lowerShell = createShellHalf(false);
    
    shellGroup.add(upperShell);
    shellGroup.add(lowerShell);
    upperShellRef.current = upperShell;
    lowerShellRef.current = lowerShell;
    
    // --- Photo Group ---
    const photoGroup = new THREE.Group();
    shellGroup.add(photoGroup);
    photoGroupRef.current = photoGroup;
    
    // Animation Loop
    const clock = new THREE.Clock();
    
    let animFrameId: number;
    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      
      const time = clock.getElapsedTime();
      stateRef.current.time = time;
      
      if (!isAnimatingCameraRef.current) {
        controls.update();
      }
      
      // Update Uniforms
      if (pearlLightRef.current && pearlMatRef.current) {
        const pulse = stateRef.current.bloomIntensity;
        pearlLightRef.current.intensity = 2 + pulse * 2;
        pearlMatRef.current.emissiveIntensity = 1 + pulse;
      }
      
      shellMat.uniforms.time.value = time;
      shellMat.uniforms.scatterProgress.value = stateRef.current.scatterProgress;
      
      // Update Shell Rotations
      if (shellGroupRef.current) {
        shellGroupRef.current.rotation.x += (targetShellRotationRef.current.x - shellGroupRef.current.rotation.x) * 0.1;
        shellGroupRef.current.rotation.y += (targetShellRotationRef.current.y - shellGroupRef.current.rotation.y) * 0.1;
      }

      // Update Shell Position
      if (shellGroupRef.current) {
        shellGroupRef.current.position.x += (targetShellPositionRef.current.x - shellGroupRef.current.position.x) * 0.1;
        shellGroupRef.current.position.y += (targetShellPositionRef.current.y - shellGroupRef.current.position.y) * 0.1;
        shellGroupRef.current.position.z += (targetShellPositionRef.current.z - shellGroupRef.current.position.z) * 0.1;

        // Throttled debug log (point C)
        const now = Date.now();
        if (now - lastDebugLogRef.current > 500) {
          lastDebugLogRef.current = now;
          const sp = shellGroupRef.current.position;
          const tp = targetShellPositionRef.current;
          console.log('[DEBUG-C] animate:', {
            shellPos: { x: sp.x.toFixed(2), y: sp.y.toFixed(2), z: sp.z.toFixed(2) },
            targetPos: { x: tp.x.toFixed(2), y: tp.y.toFixed(2), z: tp.z.toFixed(2) },
            stableGesture: stableGestureRef.current
          });
        }
      }
      
      if (upperShellRef.current) {
        // Front shell opens forward
        upperShellRef.current.rotation.x = stateRef.current.shellOpenAngle;
      }
      if (lowerShellRef.current) {
        // Back shell opens backward
        lowerShellRef.current.rotation.x = -stateRef.current.shellOpenAngle;
      }
      
      // Animate Photos
      if (photoGroupRef.current) {
        photoGroupRef.current.children.forEach((child, i) => {
          if (stateRef.current.currentState === 'SCATTERED') {
            child.position.y += Math.sin(time + i) * 0.01;
            child.rotation.y += 0.005;
          }
        });
        // Gentle floating for zoomed photo
        const zData = zoomedPhotoDataRef.current;
        if (stateRef.current.currentState === 'PHOTO_ZOOM' && zData) {
          zData.mesh.position.y += Math.sin(time * 1.5) * 0.003;
          zData.mesh.rotation.y = Math.sin(time * 0.8) * 0.03;
        }
      }
      
      composer.render();
    };
    
    animate();
    
    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    
    return () => {
      cancelAnimationFrame(animFrameId);
      controls.dispose();
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  // Update Photos when uploaded
  useEffect(() => {
    if (!photoGroupRef.current || photos.length === 0) return;
    
    const group = photoGroupRef.current;
    const textureLoader = new THREE.TextureLoader();
    
    // Only process new photos
    const newPhotos = photos.slice(processedPhotosCount.current);
    if (newPhotos.length === 0) return;
    
    newPhotos.forEach((photoUrl) => {
      textureLoader.load(photoUrl, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const aspect = texture.image.width / texture.image.height;
        const geo = new THREE.PlaneGeometry(2 * aspect, 2);
        const mat = new THREE.MeshBasicMaterial({ 
          map: texture, 
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.0,
          depthWrite: false, // Prevent z-fighting with particles
          fog: false // Ensure photos are not hidden by the scene fog
        });
        const mesh = new THREE.Mesh(geo, mat);
        
        // Position inside the shell
        const angle = Math.random() * Math.PI * 2;
        const radius = 6 + Math.random() * 4;
        const height = (Math.random() - 0.5) * 8;
        
        mesh.position.set(
          Math.cos(angle) * radius,
          height,
          Math.sin(angle) * radius
        );
        mesh.lookAt(0,0,0);
        
        group.add(mesh);
        
        if (stateRef.current.currentState === 'SCATTERED' || stateRef.current.currentState === 'PHOTO_ZOOM') {
          mat.opacity = 1; // Set directly to avoid animation issues on load
        }
      }, undefined, (err) => {
        console.error("Failed to load photo texture:", err);
      });
    });
    
    processedPhotosCount.current = photos.length;
  }, [photos]);

  // Helper: put back zoomed photo to original position
  const putBackZoomedPhoto = () => {
    const data = zoomedPhotoDataRef.current;
    if (!data) return;
    const { mesh, originalPosition, originalQuaternion } = data;
    gsap.to(mesh.position, {
      x: originalPosition.x,
      y: originalPosition.y,
      z: originalPosition.z,
      duration: 0.5,
      ease: "power2.inOut"
    });
    gsap.to(mesh.quaternion, {
      x: originalQuaternion.x,
      y: originalQuaternion.y,
      z: originalQuaternion.z,
      w: originalQuaternion.w,
      duration: 0.5,
      ease: "power2.inOut"
    });
    gsap.to(mesh.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: "power2.inOut" });
    gsap.to(mesh.material, { opacity: 0.8, duration: 0.5 });
    zoomedPhotoDataRef.current = null;
  };

  // Handle State Transitions
  const transitionTo = (newState: string) => {
    const state = stateRef.current;
    if (state.currentState === newState) return;

    // Put back zoomed photo when leaving PHOTO_ZOOM
    if (state.currentState === 'PHOTO_ZOOM' && newState !== 'PHOTO_ZOOM') {
      putBackZoomedPhoto();
      // Restore all photo opacities
      if (photoGroupRef.current) {
        photoGroupRef.current.children.forEach(child => {
          gsap.to(child.scale, { x: 1, y: 1, z: 1, duration: 0.5 });
        });
      }
    }

    // Prevent zooming if there are no photos
    if (newState === 'PHOTO_ZOOM' && (!photoGroupRef.current || photoGroupRef.current.children.length === 0)) {
      return;
    }
    
    state.currentState = newState;
    
    if (newState === 'CLOSED') {
      gsap.to(state, { shellOpenAngle: 0, duration: 1.5, ease: "power2.inOut" });
      gsap.to(state, { scatterProgress: 0, duration: 2, ease: "power2.inOut" });
      gsap.to(state, { bloomIntensity: 0.2, duration: 1 });

      // Fade pearl back in
      if (pearlRef.current) {
        gsap.to(pearlRef.current.material, { opacity: 1, duration: 1.5 });
      }

      if (photoGroupRef.current) {
        photoGroupRef.current.children.forEach(child => {
          gsap.to((child as THREE.Mesh).material, { opacity: 0, duration: 1 });
        });
      }
      
      if (cameraRef.current && controlsRef.current) {
        isAnimatingCameraRef.current = true;
        gsap.to(cameraRef.current.position, { x: 0, y: 0, z: 40, duration: 2 });
        gsap.to(controlsRef.current.target, { x: 0, y: 0, z: 0, duration: 2, onComplete: () => { isAnimatingCameraRef.current = false; } });
      }
    } 
    else if (newState === 'OPEN') {
      // Open both halves of the shell (front falls forward, back falls backward)
      gsap.to(state, { shellOpenAngle: (Math.PI / 180) * 60, duration: 2, ease: "power2.inOut" });
      gsap.to(state, { scatterProgress: 0, duration: 2, ease: "power2.inOut" });
      gsap.to(state, { bloomIntensity: 0.8, duration: 2 });

      // Fade out pearl as shell opens
      if (pearlRef.current) {
        gsap.to(pearlRef.current.material, { opacity: 0, duration: 1.5 });
      }

      if (photoGroupRef.current) {
        photoGroupRef.current.children.forEach(child => {
          gsap.to((child as THREE.Mesh).material, { opacity: 1, duration: 2, delay: 1.5 });
        });
      }

    }
    else if (newState === 'SCATTERED') {
      gsap.to(state, { scatterProgress: 1, duration: 3, ease: "power2.inOut" });
      gsap.to(state, { bloomIntensity: 0.3, duration: 2 });

      // Hide pearl during scatter
      if (pearlRef.current) {
        gsap.to(pearlRef.current.material, { opacity: 0, duration: 1 });
      }

      if (photoGroupRef.current) {
        photoGroupRef.current.children.forEach(child => {
          gsap.to((child as THREE.Mesh).material, { opacity: 1, duration: 2 });
        });
      }
      
      if (cameraRef.current && controlsRef.current) {
        isAnimatingCameraRef.current = true;
        gsap.to(cameraRef.current.position, { x: 0, y: 5, z: 50, duration: 2 });
        gsap.to(controlsRef.current.target, { x: 0, y: 0, z: 0, duration: 2, onComplete: () => { isAnimatingCameraRef.current = false; } });
      }
    }
    else if (newState === 'PHOTO_ZOOM') {
      // Lock shell to center
      targetShellPositionRef.current = { x: 0, y: 0, z: 0 };
      targetShellRotationRef.current = { x: 0, y: 0 };

      const children = photoGroupRef.current!.children;
      const count = children.length;
      if (count === 0) return;

      // Put back previous photo if any
      putBackZoomedPhoto();

      // Get next photo in cycle
      const index = currentZoomIndexRef.current % count;
      currentZoomIndexRef.current = (index + 1) % count;
      const photo = children[index] as THREE.Mesh;

      // Save original transform
      const originalPosition = photo.position.clone();
      const originalQuaternion = photo.quaternion.clone();
      zoomedPhotoDataRef.current = { mesh: photo, originalPosition, originalQuaternion };

      // Show all photos at reduced opacity
      children.forEach(child => {
        gsap.to((child as THREE.Mesh).material, { opacity: 0.3, duration: 0.5 });
      });

      // Shell is locked at origin with zero rotation, so local space ≈ world space.
      // Place photo between shell (z=0) and camera (z≈40-50), facing +Z toward camera.
      gsap.to(photo.position, {
        x: 0, y: 0, z: 25,
        duration: 0.8, ease: "back.out(1.4)"
      });

      // Reset rotation so the PlaneGeometry's front face (+Z) points toward the camera
      gsap.to(photo.quaternion, {
        x: 0, y: 0, z: 0, w: 1,
        duration: 0.8, ease: "power2.out"
      });

      // Scale up the grabbed photo
      gsap.to(photo.scale, { x: 4, y: 4, z: 4, duration: 0.8, ease: "back.out(1.7)" });
      // Full opacity for the grabbed photo
      gsap.to(photo.material, { opacity: 1, duration: 0.5 });
    }
  };

  // Initialize MediaPipe Hands
  useEffect(() => {
    if (!videoRef.current) return;

    let cancelled = false;
    let handsInstance: Hands | null = null;
    let cameraInstance: Camera | null = null;

    const initMediaPipe = async () => {
      const hands = new Hands({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
        }
      });

      if (cancelled) { hands.close(); return; }
      handsInstance = hands;

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      hands.onResults((results: Results) => {
        if (cancelled) return;
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          const landmarks = results.multiHandLandmarks[0];

          const getDist2D = (p1: any, p2: any) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

          const palmSize = getDist2D(landmarks[0], landmarks[9]);

          const isExtended = (tipIdx: number, pipIdx: number) => {
            return getDist2D(landmarks[tipIdx], landmarks[0]) > getDist2D(landmarks[pipIdx], landmarks[0]);
          };

          const indexExt = isExtended(8, 6);
          const middleExt = isExtended(12, 10);
          const ringExt = isExtended(16, 14);
          const pinkyExt = isExtended(20, 18);

          const thumbIndexDist = getDist2D(landmarks[4], landmarks[8]) / palmSize;

          const allExt = indexExt && middleExt && ringExt && pinkyExt;
          const noneExt = !indexExt && !middleExt && !ringExt && !pinkyExt;
          const peaceExt = indexExt && middleExt && !ringExt && !pinkyExt;

          let detectedGesture = 'UNKNOWN';

          if (thumbIndexDist < 0.3 && (middleExt || ringExt || pinkyExt)) {
            detectedGesture = 'OK';
          } else if (noneExt) {
            detectedGesture = 'FIST';
          } else if (peaceExt) {
            detectedGesture = 'PEACE';
          } else if (allExt) {
            detectedGesture = 'OPEN';
          }

          // Update raw gesture ref for debug display
          rawGestureRef.current = detectedGesture;
          landmark9Ref.current = { x: landmarks[9].x, y: landmarks[9].y };

          // Debounce gesture: require GESTURE_STABILITY_FRAMES consecutive identical frames
          const buffer = gestureBufferRef.current;
          buffer.push(detectedGesture);
          if (buffer.length > GESTURE_STABILITY_FRAMES) buffer.shift();

          if (buffer.length === GESTURE_STABILITY_FRAMES && buffer.every(g => g === detectedGesture)) {
            if (stableGestureRef.current !== detectedGesture) {
              stableGestureRef.current = detectedGesture;
              setGesture(detectedGesture);
            }
          }

          // In PHOTO_ZOOM: lock shell to center; otherwise follow hand
          if (stateRef.current.currentState === 'PHOTO_ZOOM') {
            targetShellPositionRef.current = { x: 0, y: 0, z: 0 };
            targetShellRotationRef.current = { x: 0, y: 0 };
          } else {
            const posX = -(landmarks[9].x - 0.5) * 70;
            const posY = -(landmarks[9].y - 0.5) * 50;
            targetShellPositionRef.current = { x: posX, y: posY, z: 0 };

            const targetY = (landmarks[9].x - 0.5) * Math.PI * 2;
            const targetX = (landmarks[9].y - 0.5) * Math.PI;
            targetShellRotationRef.current = { x: targetX, y: targetY };
          }

          // Throttled debug log (point B)
          {
            const now = Date.now();
            if (now - lastDebugLogRef.current > 500) {
              lastDebugLogRef.current = now;
              const tp = targetShellPositionRef.current;
              console.log('[DEBUG-B] hand position:', { posX: tp.x.toFixed(2), posY: tp.y.toFixed(2), landmark9: { x: landmarks[9].x.toFixed(3), y: landmarks[9].y.toFixed(3) } });
            }
          }

          // Throttled debug log (point A)
          {
            const now = Date.now();
            if (now - lastDebugLogRef.current > 500) {
              lastDebugLogRef.current = now;
              console.log('[DEBUG-A] Gesture:', { detected: detectedGesture, stable: stableGestureRef.current, bufferLen: gestureBufferRef.current.length });
            }
          }

          if (detectedGesture === 'OK') {
            handPositionRef.current = { x: landmarks[9].x, y: landmarks[9].y };
          }

          if (stateRef.current.currentState === 'SCATTERED' && detectedGesture !== 'OK' && detectedGesture !== 'FIST' && detectedGesture !== 'PEACE') {
             if (cameraRef.current && controlsRef.current) {
               const x = (landmarks[9].x - 0.5) * 2;
               const y = -(landmarks[9].y - 0.5) * 2;

               const targetX = x * 20;
               const targetY = Math.max(2, y * 20 + 10);

               gsap.to(cameraRef.current.position, {
                 x: targetX,
                 y: targetY,
                 duration: 0.5,
                 ease: "power1.out"
               });
             }
          }
        }
      });

      if (cancelled || !videoRef.current) { hands.close(); return; }

      const camera = new Camera(videoRef.current, {
        onFrame: async () => {
          if (!cancelled && videoRef.current) {
            await hands.send({ image: videoRef.current });
          }
        },
        width: 640,
        height: 480
      });
      cameraInstance = camera;

      // Override alert to prevent mediapipe from showing annoying popups
      const originalAlert = window.alert;
      window.alert = () => {};

      try {
        await camera.start();
      } catch (err: any) {
        console.error("Camera start failed:", err);
        if (!cancelled) {
          setCameraError(err.message || "Failed to access camera. Please ensure permissions are granted.");
        }
      } finally {
        window.alert = originalAlert;
      }

      if (cancelled) {
        camera.stop();
        hands.close();
      }
    };

    initMediaPipe();

    return () => {
      cancelled = true;
      if (cameraInstance) cameraInstance.stop();
      if (handsInstance) handsInstance.close();
      gestureBufferRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (gesture === 'FIST') transitionTo('CLOSED');
    else if (gesture === 'PEACE') transitionTo('OPEN');
    else if (gesture === 'OPEN') transitionTo('SCATTERED');
    else if (gesture === 'OK') transitionTo('PHOTO_ZOOM');
  }, [gesture]);

  // Debug info update interval (200ms)
  useEffect(() => {
    const interval = setInterval(() => {
      const shellGroup = shellGroupRef.current;
      setDebugInfo({
        rawGesture: rawGestureRef.current,
        stableGesture: stableGestureRef.current,
        landmark9: { ...landmark9Ref.current },
        targetPos: { ...targetShellPositionRef.current },
        shellPos: shellGroup
          ? { x: shellGroup.position.x, y: shellGroup.position.y, z: shellGroup.position.z }
          : { x: 0, y: 0, z: 0 },
      });
    }, 200);
    return () => clearInterval(interval);
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = e.target.files;
      const newPhotos: string[] = [];
      for (let i = 0; i < files.length; i++) {
        newPhotos.push(URL.createObjectURL(files[i]));
      }
      setPhotos(prev => [...prev, ...newPhotos]);
      
      // Reset input value so the same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      
      // Automatically transition to SCATTERED state to show the photos
      transitionTo('SCATTERED');
    }
  };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#d48a56]">
      {/* Three.js Canvas Container */}
      <div ref={mountRef} className="absolute inset-0 z-0" />
      
      {/* UI Overlay */}
      <div className="absolute top-0 left-0 w-full p-6 z-10 pointer-events-none flex justify-between items-start">
        <div className="text-white font-sans">
          <h1 className="text-3xl font-light tracking-widest mb-2 text-transparent bg-clip-text bg-gradient-to-r from-orange-100 to-orange-300">
            PEARL & SHELL
          </h1>
          <p className="text-sm text-white/80 uppercase tracking-widest">Interactive Particle System</p>
          
          <div className="mt-8 space-y-2 text-xs text-white/90 bg-black/20 p-4 rounded-xl backdrop-blur-md border border-white/20">
            <p className="font-bold text-white mb-2">GESTURE CONTROLS:</p>
            <p><span className="inline-block w-16 text-orange-200">FIST</span> Close Shell</p>
            <p><span className="inline-block w-16 text-orange-200">PEACE</span> Open Shell</p>
            <p><span className="inline-block w-16 text-orange-200">OPEN</span> Scatter Particles</p>
            <p><span className="inline-block w-16 text-orange-200">OK</span> Zoom Photo</p>
            
            <div className="mt-4 pt-4 border-t border-white/20">
              <p>Raw Gesture: <span className="font-bold text-white">{debugInfo.rawGesture}</span></p>
              <p>Stable Gesture: <span className="font-bold text-white">{debugInfo.stableGesture}</span></p>
              <p>Current State: <span className="font-bold text-white">{stateRef.current.currentState}</span></p>
              <p>Landmark9: <span className="font-bold text-white font-mono text-[10px]">({debugInfo.landmark9.x.toFixed(3)}, {debugInfo.landmark9.y.toFixed(3)})</span></p>
              <p>Target Pos: <span className="font-bold text-white font-mono text-[10px]">({debugInfo.targetPos.x.toFixed(2)}, {debugInfo.targetPos.y.toFixed(2)}, {debugInfo.targetPos.z.toFixed(2)})</span></p>
              <p>Shell Pos: <span className="font-bold text-white font-mono text-[10px]">({debugInfo.shellPos.x.toFixed(2)}, {debugInfo.shellPos.y.toFixed(2)}, {debugInfo.shellPos.z.toFixed(2)})</span></p>
            </div>
          </div>
        </div>
        
        <div className="pointer-events-auto">
          <label className="cursor-pointer bg-white/20 hover:bg-white/30 transition-colors px-6 py-3 rounded-full text-sm text-white backdrop-blur-md border border-white/30 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
            Upload Photos {photos.length > 0 && <span className="bg-orange-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{photos.length}</span>}
            <input 
              type="file" 
              multiple 
              accept="image/*" 
              className="hidden" 
              onChange={handleFileUpload}
              ref={fileInputRef}
            />
          </label>
        </div>
      </div>
      
      {/* Camera Error Message */}
      {cameraError && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-500/90 text-white px-8 py-6 rounded-2xl text-center z-50 backdrop-blur-md max-w-md shadow-2xl border border-white/20">
          <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </div>
          <h3 className="text-xl font-bold mb-2">Camera Access Denied</h3>
          <p className="text-sm mb-4 opacity-90">{cameraError}</p>
          <div className="bg-black/20 rounded-lg p-3 text-xs text-left mb-4">
            <p className="font-semibold mb-1">How to fix:</p>
            <ol className="list-decimal pl-4 space-y-1 opacity-80">
              <li>Click the camera icon in your browser's address bar</li>
              <li>Select "Always allow"</li>
              <li>Refresh the page</li>
            </ol>
          </div>
          <button 
            onClick={() => window.location.reload()}
            className="bg-white text-red-600 font-bold py-2 px-6 rounded-full hover:bg-red-50 transition-colors w-full"
          >
            Refresh Page
          </button>
        </div>
      )}

      {/* UI Hint for FIST */}
      {gesture === 'FIST' && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-black/50 text-white px-6 py-3 rounded-full backdrop-blur-md border border-white/20 animate-pulse z-50">
          Move your fist to rotate the shell
        </div>
      )}

      {/* Camera Preview (Optional, for debugging) */}
      <div className="absolute bottom-6 right-6 w-48 h-36 bg-black/30 rounded-2xl overflow-hidden border border-white/20 backdrop-blur-md z-10 pointer-events-none">
        <video 
          ref={videoRef} 
          className="w-full h-full object-cover scale-x-[-1]" 
          playsInline 
          autoPlay 
          muted 
        />
        <div className="absolute bottom-2 left-2 text-[10px] text-white/70 uppercase tracking-wider">Camera Input</div>
      </div>
    </div>
  );
}
