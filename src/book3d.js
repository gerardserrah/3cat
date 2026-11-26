import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Generates a realistic paper-edges texture (fine horizontal page striations)
 * for the top, bottom, and fore-edge of the book block.
 */
function createPageEdgeTexture(horizontal = true) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f5f1e8';
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 512; i += 2) {
    const shade = 228 + Math.floor(Math.sin(i * 1.7) * 10 + (Math.random() - 0.5) * 14);
    ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 10})`;
    if (horizontal) {
      ctx.fillRect(0, i, 512, 1.5);
    } else {
      ctx.fillRect(i, 0, 1.5, 512);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Generates a subtle linen/paper endpaper texture for inside covers.
 */
function createEndpaperTexture(color = '#f7f4ec') {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.025})`;
    ctx.fillRect(x, y, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Book3DEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.alphaMatte = false;
    this.savedMaterials = new Map();
    this.bgColor = '#111318';
    this.shadowEnabled = true;

    // Book state
    this.format = {
      pageWidthMm: 240,
      pageHeightMm: 240,
      spineWidthMm: 10,
      overhangMm: 3,
      boardThicknessMm: 2.6,
      maxOpenAngleDeg: 172,
      coverType: 'hardcover',
      finish: 0.35, // 0 = matte, 1 = glossy
    };

    this.textures = {
      front: null,
      back: null,
      spine: null,
      frontInside: null,
      backInside: null,
      edgeColor: '#a8222a',
      pages: [], // array of THREE.CanvasTexture
      endpaper: createEndpaperTexture(),
      pageEdgeH: createPageEdgeTexture(true),
      pageEdgeV: createPageEdgeTexture(false),
    };

    // Transform & animation state
    this.userTransform = {
      rotX: 10,
      rotY: -20,
      rotZ: 0,
      posX: 0,
      posY: 0,
    };
    this.animOffset = {
      rotY: 0,
      rotX: 0,
      posX: 0,
      openAmount: 0,     // 0 = closed, 1 = fully open
      flipProgress: 0,   // 0..1 across interior pages
      flipSheetCount: 16,
    };

    this._initScene();
    this._initLights();
    this._initBookRoot();
    this.rebuildBook();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.bgColor);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(0, 0.12, 10.0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 18;
    this.controls.target.set(0, 0, 0);

    // No ground shadow plane (shadows only between pages)
    // Pure white material for Alpha Matte B/W export
    this.matteMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
  }

  _initLights() {
    this.ambientLight = new THREE.HemisphereLight(0xffffff, 0xe8e4dc, 0.72);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xfffaf2, 1.5);
    this.keyLight.position.set(2.8, 4.2, 4.8);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 18;
    this.keyLight.shadow.camera.left = -3.8;
    this.keyLight.shadow.camera.right = 3.8;
    this.keyLight.shadow.camera.top = 3.8;
    this.keyLight.shadow.camera.bottom = -3.8;
    this.keyLight.shadow.bias = -0.0008;
    this.keyLight.shadow.normalBias = 0.015;
    this.keyLight.shadow.radius = 12;
    this.keyLight.shadow.blurSamples = 25;
    this.keyLight.shadow.intensity = 0.25;
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0xe4eeff, 0.72);
    this.fillLight.position.set(-4.0, 1.8, 3.0);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.DirectionalLight(0xffffff, 0.45);
    this.rimLight.position.set(0, 3.0, -4.5);
    this.scene.add(this.rimLight);
  }

  _initBookRoot() {
    // Outer group handles user position & rotation + 180° turn animation
    this.bookTransformGroup = new THREE.Group();
    this.scene.add(this.bookTransformGroup);

    // Inner group shifts slightly when opening so the open spread stays centered
    this.bookCenterGroup = new THREE.Group();
    this.bookTransformGroup.add(this.bookCenterGroup);
  }

  setCoverTextures({ frontCanvas, backCanvas, spineCanvas, frontInsideCanvas, backInsideCanvas, edgeColor }) {
    const makeTex = (canvas) => {
      if (!canvas) return null;
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      return t;
    };

    if (this.textures.front) this.textures.front.dispose();
    if (this.textures.back) this.textures.back.dispose();
    if (this.textures.spine) this.textures.spine.dispose();
    if (this.textures.frontInside) this.textures.frontInside.dispose();
    if (this.textures.backInside) this.textures.backInside.dispose();

    this.textures.front = makeTex(frontCanvas);
    this.textures.back = makeTex(backCanvas);
    this.textures.spine = makeTex(spineCanvas);
    this.textures.frontInside = makeTex(frontInsideCanvas);
    this.textures.backInside = makeTex(backInsideCanvas);
    this.textures.edgeColor = edgeColor || '#882222';
    this.rebuildBook();
  }

  setInteriorPages(pageCanvases) {
    for (const t of this.textures.pages) t.dispose();
    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.textures.pages = pageCanvases.map((c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      return t;
    });
    this.rebuildBook();
  }

  updateFormat(partial) {
    Object.assign(this.format, partial);
    this.rebuildBook();
  }

  _clearBookMeshes() {
    while (this.bookCenterGroup.children.length > 0) {
      const child = this.bookCenterGroup.children[0];
      this.bookCenterGroup.remove(child);
      child.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
      });
    }
    this.turningLeaves = [];
  }

  rebuildBook() {
    const wasAlpha = this.alphaMatte;
    if (wasAlpha) this.setAlphaMatte(false);

    this._clearBookMeshes();

    const { pageWidthMm, pageHeightMm, spineWidthMm, overhangMm, boardThicknessMm, coverType, finish } = this.format;
    const isHard = coverType === 'hardcover';
    const isMagazine = coverType === 'magazine';

    // Normalize book height to ~2.2 world units
    const mmToUnit = 2.2 / Math.max(80, pageHeightMm);
    const pageW = pageWidthMm * mmToUnit;
    const pageH = pageHeightMm * mmToUnit;
    const overhang = isHard ? Math.max(2.5, overhangMm || 3.0) * mmToUnit : 0;
    const boardThick = (isHard ? Math.max(0.8, boardThicknessMm || 2.6) : isMagazine ? 0.22 : 0.45) * mmToUnit;
    // Magazine: ultra-slim saddle-stitched fold with NO thick spine!
    const rawSpineW = isMagazine
      ? Math.min(2.2, Math.max(1.2, spineWidthMm * 0.22)) * mmToUnit
      : Math.max(4, spineWidthMm) * mmToUnit;
    const spineW = isMagazine ? Math.max(rawSpineW, boardThick * 2 + 0.008) : Math.max(rawSpineW, boardThick * 2 + 0.02);
    const blockThick = Math.max(isMagazine ? 0.007 : 0.015, spineW - boardThick * 2);

    const coverW = pageW + overhang;
    const coverH = pageH + overhang * 2;

    this.dims = { pageW, pageH, coverW, coverH, boardThick, spineW, blockThick, overhang, isHard, isMagazine };

    // Cover material roughness based on finish slider (magazines have slightly glossier coated paper feel)
    const effFinish = isMagazine ? Math.min(0.95, finish + 0.2) : finish;
    const roughness = 0.78 - effFinish * 0.62;
    const clearcoat = isHard ? 0.1 + effFinish * 0.45 : isMagazine ? 0.25 + effFinish * 0.45 : effFinish * 0.35;

    const makeCoverMat = (map, color = 0xffffff) =>
      new THREE.MeshPhysicalMaterial({
        map: map || null,
        color: map ? 0xffffff : color,
        roughness,
        metalness: 0.02,
        clearcoat,
        clearcoatRoughness: 0.25 + (1 - finish) * 0.4,
      });

    const boardEdgeMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.textures.edgeColor),
      roughness: 0.65,
      metalness: 0.02,
    });

    const endpaperMat = new THREE.MeshStandardMaterial({
      map: this.textures.endpaper,
      roughness: 0.88,
      metalness: 0.0,
    });

    const frontInsideMat = new THREE.MeshStandardMaterial({
      map: isHard && this.textures.frontInside ? this.textures.frontInside : this.textures.endpaper,
      roughness: 0.84,
      metalness: 0.0,
    });

    const backInsideMat = new THREE.MeshStandardMaterial({
      map: isHard && this.textures.backInside ? this.textures.backInside : this.textures.endpaper,
      roughness: 0.84,
      metalness: 0.0,
    });

    const pageEdgeMatH = new THREE.MeshStandardMaterial({
      map: this.textures.pageEdgeH,
      roughness: 0.9,
      metalness: 0.0,
    });
    const pageEdgeMatV = new THREE.MeshStandardMaterial({
      map: this.textures.pageEdgeV,
      roughness: 0.9,
      metalness: 0.0,
    });

    // Book spine sits at x = -coverW / 2 so closed book is centered at x = 0
    const spineX = -coverW / 2;

    // 1. SPINE MESH (for Magazine, render an ultra-slim rounded fold edge instead of a flat spine!)
    const spineGeo = isMagazine
      ? new THREE.CylinderGeometry(spineW / 2, spineW / 2, coverH, 10, 1, false, Math.PI, Math.PI)
      : new THREE.BoxGeometry(boardThick, coverH, spineW);
    const spineMat = makeCoverMat(isMagazine ? null : this.textures.spine, this.textures.edgeColor);
    const spineMaterials = isMagazine
      ? spineMat
      : [
          endpaperMat,   // +x (inner spine)
          spineMat,      // -x (outer spine, facing left)
          boardEdgeMat,  // +y (top)
          boardEdgeMat,  // -y (bottom)
          boardEdgeMat,  // +z
          boardEdgeMat,  // -z
        ];
    this.spineMesh = new THREE.Mesh(spineGeo, spineMaterials);
    this.spineMesh.position.set(isMagazine ? spineX : spineX - boardThick / 2, 0, 0);
    this.spineMesh.castShadow = true;
    this.spineMesh.receiveShadow = true;
    this.bookCenterGroup.add(this.spineMesh);

    // Optional decorative headbands (capçaletes) for hardcover
    if (isHard) {
      const hbMat = new THREE.MeshStandardMaterial({ color: 0xf0ece0, roughness: 0.85 });
      const hbGeo = new THREE.CylinderGeometry(blockThick * 0.45, blockThick * 0.45, 0.025, 10, 1, false, 0, Math.PI);
      const hbTop = new THREE.Mesh(hbGeo, hbMat);
      hbTop.rotation.x = Math.PI / 2;
      hbTop.position.set(spineX + 0.01, pageH / 2 + 0.005, 0);
      const hbBot = hbTop.clone();
      hbBot.position.y = -pageH / 2 - 0.005;
      this.bookCenterGroup.add(hbTop, hbBot);
    }

    // 2. FRONT COVER (pivots from front-left hinge at spineX, +spineW/2)
    this.frontCoverPivot = new THREE.Group();
    this.frontCoverPivot.position.set(spineX, 0, spineW / 2 - boardThick / 2);
    this.bookCenterGroup.add(this.frontCoverPivot);

    const frontGeo = new THREE.BoxGeometry(coverW, coverH, boardThick);
    const frontFaceMat = makeCoverMat(this.textures.front, 0xb8292f);
    // BoxGeometry material order: +x, -x, +y, -y, +z (front), -z (inside with folded cover turn-ins)
    const frontMats = [boardEdgeMat, boardEdgeMat, boardEdgeMat, boardEdgeMat, frontFaceMat, frontInsideMat];
    this.frontCoverMesh = new THREE.Mesh(frontGeo, frontMats);
    this.frontCoverMesh.position.set(coverW / 2, 0, 0);
    this.frontCoverMesh.castShadow = true;
    this.frontCoverMesh.receiveShadow = true;
    this.frontCoverPivot.add(this.frontCoverMesh);

    // Hardcover hinge groove visual detail
    if (isHard) {
      const grooveGeo = new THREE.BoxGeometry(0.012, coverH - 0.004, boardThick + 0.003);
      const grooveMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.textures.edgeColor).multiplyScalar(0.7),
        roughness: 0.7,
      });
      const frontGroove = new THREE.Mesh(grooveGeo, grooveMat);
      frontGroove.position.set(0.055, 0, 0);
      this.frontCoverPivot.add(frontGroove);
    }

    // 3. BACK COVER (pivots from back-left hinge at spineX, -spineW/2)
    this.backCoverPivot = new THREE.Group();
    this.backCoverPivot.position.set(spineX, 0, -spineW / 2 + boardThick / 2);
    this.bookCenterGroup.add(this.backCoverPivot);

    const backGeo = new THREE.BoxGeometry(coverW, coverH, boardThick);
    const backFaceMat = makeCoverMat(this.textures.back, 0xb8292f);
    // +z is inside back cover (with folded cover turn-ins), -z is outside back cover
    const backMats = [boardEdgeMat, boardEdgeMat, boardEdgeMat, boardEdgeMat, backInsideMat, backFaceMat];
    this.backCoverMesh = new THREE.Mesh(backGeo, backMats);
    this.backCoverMesh.position.set(coverW / 2, 0, 0);
    this.backCoverMesh.castShadow = true;
    this.backCoverMesh.receiveShadow = true;
    this.backCoverPivot.add(this.backCoverMesh);

    if (isHard) {
      const grooveGeo = new THREE.BoxGeometry(0.012, coverH - 0.004, boardThick + 0.003);
      const grooveMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.textures.edgeColor).multiplyScalar(0.7),
        roughness: 0.7,
      });
      const backGroove = new THREE.Mesh(grooveGeo, grooveMat);
      backGroove.position.set(0.055, 0, 0);
      this.backCoverPivot.add(backGroove);
    }

    // 4. PAGE BLOCKS — physically mounted to the INSIDE of each cover board!
    // Right stack sits on the inside (+z local) of backCoverPivot;
    // Left stack sits on the inside (-z local) of frontCoverPivot.
    // This guarantees ZERO clipping and ZERO pop-in/pop-out at every opening/closing angle!
    this.rightTopPageMat = new THREE.MeshStandardMaterial({
      map: this._getPageTex(0),
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    const rightBlockGeo = new THREE.BoxGeometry(pageW, pageH, blockThick);
    const rightBlockMats = [pageEdgeMatV, pageEdgeMatV, pageEdgeMatH, pageEdgeMatH, this.rightTopPageMat, endpaperMat];
    this.rightBlockMesh = new THREE.Mesh(rightBlockGeo, rightBlockMats);
    this.rightBlockMesh.position.set(pageW / 2 + 0.002, 0, boardThick / 2 + blockThick / 2);
    this.rightBlockMesh.castShadow = true;
    this.rightBlockMesh.receiveShadow = true;
    this.backCoverPivot.add(this.rightBlockMesh);

    this.leftTopPageMat = new THREE.MeshStandardMaterial({
      map: this._getPageTex(1),
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    const leftBlockGeo = new THREE.BoxGeometry(pageW, pageH, blockThick);
    // Inside front cover faces -z local (which points toward viewer when front cover is open!)
    const leftBlockMats = [pageEdgeMatV, pageEdgeMatV, pageEdgeMatH, pageEdgeMatH, endpaperMat, this.leftTopPageMat];
    this.leftBlockMesh = new THREE.Mesh(leftBlockGeo, leftBlockMats);
    this.leftBlockMesh.position.set(pageW / 2 + 0.002, 0, -boardThick / 2 - blockThick / 2);
    this.leftBlockMesh.castShadow = true;
    this.leftBlockMesh.receiveShadow = true;
    this.leftBlockMesh.visible = false;
    this.frontCoverPivot.add(this.leftBlockMesh);

    // 5. ANIMATED BENDING LEAVES POOL (for fluid rapid page-flipping)
    this.leavesGroup = new THREE.Group();
    this.leavesGroup.position.set(spineX + 0.004, 0, 0);
    this.bookCenterGroup.add(this.leavesGroup);

    const POOL_SIZE = 10;
    const SEG_X = 24;
    this.turningLeaves = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const geoFront = new THREE.PlaneGeometry(pageW, pageH, SEG_X, 1);
      geoFront.translate(pageW / 2, 0, 0);

      const geoBack = new THREE.PlaneGeometry(pageW, pageH, SEG_X, 1);
      geoBack.translate(pageW / 2, 0, 0);

      const matFront = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0,
        side: THREE.FrontSide,
      });
      const matBack = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0,
        side: THREE.BackSide,
      });

      // Mirror UV horizontally on back face so text reads correctly when flipped 180°
      const uvBack = geoBack.attributes.uv;
      for (let u = 0; u < uvBack.count; u++) {
        uvBack.setX(u, 1 - uvBack.getX(u));
      }

      const meshFront = new THREE.Mesh(geoFront, matFront);
      const meshBack = new THREE.Mesh(geoBack, matBack);
      meshFront.castShadow = true;
      meshFront.receiveShadow = true;
      meshBack.castShadow = true;
      meshBack.receiveShadow = true;

      const group = new THREE.Group();
      group.add(meshFront, meshBack);
      group.visible = false;
      this.leavesGroup.add(group);

      this.turningLeaves.push({
        group,
        geoFront,
        geoBack,
        matFront,
        matBack,
        baseX: Float32Array.from(geoFront.attributes.position.array),
      });
    }

    // Apply initial state
    this.applyState();
    if (wasAlpha) this.setAlphaMatte(true);
  }

  _getPageTex(index) {
    if (!this.textures.pages.length) return this.textures.endpaper;
    const clamped = Math.max(0, Math.min(this.textures.pages.length - 1, index));
    return this.textures.pages[clamped];
  }

  /**
   * Updates book transforms, opening angle, page stack proportions, and bending leaves.
   */
  applyState() {
    if (!this.frontCoverPivot) return;

    const { pageW, blockThick, spineW, boardThick } = this.dims;
    const open = Math.max(0, Math.min(1, this.animOffset.openAmount));
    const progress = Math.max(0, Math.min(1, this.animOffset.flipProgress));

    // Apply user + animation transforms
    const deg2rad = Math.PI / 180;
    this.bookTransformGroup.rotation.set(
      (this.userTransform.rotX + this.animOffset.rotX) * deg2rad,
      (this.userTransform.rotY + this.animOffset.rotY) * deg2rad,
      this.userTransform.rotZ * deg2rad
    );
    this.bookTransformGroup.position.set(
      this.userTransform.posX + this.animOffset.posX,
      this.userTransform.posY,
      0
    );

    // Compute symmetrical cover angles for the chosen max opening angle (60°..180°)
    const maxOpenRad = (Math.max(40, Math.min(180, this.format.maxOpenAngleDeg || 172)) * Math.PI) / 180;
    const halfClose = (Math.PI - maxOpenRad) / 2;

    // Shift center group right as book opens so the open spread stays balanced in center
    this.bookCenterGroup.position.x = open * (pageW * 0.48 * Math.sin(maxOpenRad / 2));

    // Cover pivots stay at their true physical spine hinges — rightBlock is mounted inside backCover,
    // leftBlock is mounted inside frontCover!
    const closedFrontZ = spineW / 2 - boardThick / 2;
    const closedBackZ = -spineW / 2 + boardThick / 2;

    const backAngle = open * (-halfClose);
    const frontAngle = open * (-(Math.PI - halfClose));

    this.frontCoverPivot.position.z = closedFrontZ;
    this.backCoverPivot.position.z = closedBackZ;
    this.spineMesh.position.z = 0;

    this.frontCoverPivot.rotation.y = frontAngle;
    this.backCoverPivot.rotation.y = backAngle;
    this.spineMesh.rotation.y = open * (-halfClose);

    // Total number of turning sheets to flip through
    const totalPages = this.textures.pages.length;
    const maxSheets = Math.max(1, Math.floor(totalPages / 2));
    const sheetCount = Math.min(maxSheets, this.animOffset.flipSheetCount);

    // High overlap (3.4) creates a continuous cascading fan of 3-4 pages flipping smoothly with ZERO pauses!
    // Map progress [0..1] across [-overlap/2 .. (sheetCount-1) + overlap/2] so:
    // - at progress=0, EVERY sheet starts cleanly resting at localT <= 0 (zero pop-in!)
    // - at progress=1, EVERY sheet finishes cleanly landed at localT >= 1 (zero pop-out!)
    const overlap = 3.4;
    const startOffset = -overlap / 2;
    const endOffset = (sheetCount - 1) + overlap / 2;
    const continuousSheet = startOffset + progress * (endOffset - startOffset);
    const completedSheets = Math.floor(continuousSheet);

    // Map sheet index evenly across interior pages (skipping blank outer paste-down page 0 and last page if >= 6 pages)
    const firstContentPair = totalPages >= 6 ? 1 : 0;
    const lastContentPair = Math.max(firstContentPair, Math.floor(totalPages / 2) - (totalPages >= 6 ? 2 : 1));
    const sheetToPagePair = (sIdx) => {
      if (totalPages < 2) return [0, 0];
      const clampedS = Math.max(0, Math.min(sheetCount - 1, sIdx));
      const norm = sheetCount > 1 ? clampedS / (sheetCount - 1) : 0;
      const pairIdx = Math.round(firstContentPair + norm * (lastContentPair - firstContentPair));
      const frontIdx = pairIdx * 2;
      const backIdx = Math.min(totalPages - 1, frontIdx + 1);
      return [frontIdx, backIdx];
    };

    // Collect active sheets FIRST so static stacks appear/disappear strictly BEHIND a turning sheet!
    // - rightBlockMesh stays visible ONLY while at least one unflipped sheet remains resting on the right (remainingRight > 0).
    //   The exact moment the last sheet begins lifting (t=0, still covering the right cover), rightBlockMesh turns off seamlessly behind it!
    // - leftBlockMesh turns on ONLY after the first sheet has completely landed on the left (landedLeft > 0),
    //   at the exact same angle & texture as the landed sheet — ZERO pop-in, ZERO pop-out!
    const activeSheets = [];
    if (open >= 0.005) {
      const scanMargin = Math.ceil(overlap) + 2;
      for (
        let s = Math.max(0, completedSheets - scanMargin);
        s <= Math.min(sheetCount - 1, completedSheets + scanMargin);
        s++
      ) {
        const localT = (continuousSheet - s) / overlap + 0.5;
        if (localT > 0.001 && localT < 0.999) {
          activeSheets.push({ s, localT });
        }
      }
    }

    const minActiveS = activeSheets.length ? activeSheets[0].s : (progress >= 0.5 ? sheetCount : 0);
    const maxActiveS = activeSheets.length ? activeSheets[activeSheets.length - 1].s : (progress >= 0.5 ? sheetCount - 1 : -1);

    const landedLeftCount = Math.max(0, minActiveS);
    const remainingRightCount = Math.max(0, (sheetCount - 1) - maxActiveS);

    // Partition physical block thickness smoothly according to landed vs remaining sheets
    const leftFrac = landedLeftCount / sheetCount;
    const rightFrac = remainingRightCount / sheetCount;

    // When completely closed (open < 0.005), show full block on whichever side holds the pages
    if (open < 0.005) {
      const showLeft = progress >= 0.5;
      this.leftBlockMesh.visible = showLeft;
      if (showLeft) {
        this.leftBlockMesh.scale.z = 1;
        this.leftBlockMesh.position.z = -boardThick / 2 - blockThick / 2;
      }
      this.rightBlockMesh.visible = !showLeft;
      if (!showLeft) {
        this.rightBlockMesh.scale.z = 1;
        this.rightBlockMesh.position.z = boardThick / 2 + blockThick / 2;
      }
      for (const leaf of this.turningLeaves) leaf.group.visible = false;
      return;
    }

    this.rightBlockMesh.visible = remainingRightCount > 0;
    if (this.rightBlockMesh.visible) {
      const rThick = Math.max(0.003, blockThick * rightFrac);
      this.rightBlockMesh.scale.z = rThick / blockThick;
      this.rightBlockMesh.position.z = boardThick / 2 + rThick / 2;
    }

    this.leftBlockMesh.visible = landedLeftCount > 0;
    if (this.leftBlockMesh.visible) {
      const lThick = Math.max(0.003, blockThick * leftFrac);
      this.leftBlockMesh.scale.z = lThick / blockThick;
      this.leftBlockMesh.position.z = -boardThick / 2 - lThick / 2;
    }

    const leftSheetIdx = Math.max(0, landedLeftCount - 1);
    const rightSheetIdx = Math.min(sheetCount - 1, maxActiveS + 1);

    const [, leftStaticIdx] = sheetToPagePair(leftSheetIdx);
    const [rightStaticIdx] = sheetToPagePair(rightSheetIdx);

    if (!this.alphaMatte) {
      this.leftTopPageMat.map = this._getPageTex(leftStaticIdx);
      this.leftTopPageMat.needsUpdate = true;
      this.rightTopPageMat.map = this._getPageTex(rightStaticIdx);
      this.rightTopPageMat.needsUpdate = true;
    }

    // Turning leaves lift cleanly in front of the right stack and land cleanly in front of the left stack!
    // Note: when frontCoverPivot rotates by frontAngle (~ -PI), local -Z maps to +Z world via (-cos(frontAngle)).
    // So the visible top surface of leftBlockMesh in book-space Z is:
    //   closedFrontZ + (boardThick/2 + lThick) * (-cos(frontAngle))
    let poolIdx = 0;
    const rStackThick = remainingRightCount > 0 ? Math.max(0.003, blockThick * rightFrac) : 0;
    const lStackThick = landedLeftCount > 0 ? Math.max(0.003, blockThick * leftFrac) : 0;

    const rSurfaceZ = closedBackZ + (boardThick / 2 + rStackThick) * Math.cos(backAngle);
    const lSurfaceZ = closedFrontZ - (boardThick / 2 + lStackThick) * Math.cos(frontAngle);

    // Minimum guaranteed separation between stacks and every concurrent leaf (zero z-fighting/overlap!)
    const baseClearance = 0.005;
    const perLeafGap = 0.0035;

    for (const item of activeSheets) {
      if (poolIdx >= this.turningLeaves.length) break;
      const { s, localT } = item;
      const leaf = this.turningLeaves[poolIdx];
      leaf.group.visible = true;

      // Continuous fluid velocity per leaf (no per-page stop/pause!)
      const smooth = localT * localT * (3 - 2 * localT);
      const t = localT * 0.78 + smooth * 0.22;
      // Keep a tiny angular gap (~0.5deg) at start/end so leaf never sits coplanar with the stack underneath
      const angleMargin = 0.008;
      const angle = backAngle + (frontAngle - backAngle) * (angleMargin + t * (1 - angleMargin * 2));

      // Each leaf in the cascade gets its own distinct Z plane strictly in front of both stacks
      const layerGap = baseClearance + (activeSheets.length - poolIdx) * perLeafGap;
      leaf.group.rotation.y = angle;
      leaf.group.position.z = rSurfaceZ + (lSurfaceZ - rSurfaceZ) * t + layerGap;

      // Scale paper bend by open^2 so partially-open leaves NEVER bend out through covers!
      const bendScale = open * open;
      const bendStrength = Math.sin(t * Math.PI * 2) * pageW * 0.095 * bendScale;

      this._deformLeaf(leaf.geoFront, leaf.baseX, bendStrength, 0.0012);
      this._deformLeaf(leaf.geoBack, leaf.baseX, bendStrength, -0.0012);

      if (!this.alphaMatte) {
        const [frontPageIdx, backPageIdx] = sheetToPagePair(s);
        leaf.matFront.map = this._getPageTex(frontPageIdx);
        leaf.matBack.map = this._getPageTex(backPageIdx);
      }
      poolIdx++;
    }

    // Hide unused pool leaves
    for (let i = poolIdx; i < this.turningLeaves.length; i++) {
      this.turningLeaves[i].group.visible = false;
    }
  }

  _deformLeaf(geo, basePos, bendStrength, zOffset) {
    const pos = geo.attributes.position;
    const { pageW } = this.dims;
    for (let i = 0; i < pos.count; i++) {
      const bx = basePos[i * 3];
      const u = bx / pageW; // 0 at spine, 1 at outer edge
      // Natural paper arch: zero at spine, smooth curve across page width
      const z = Math.sin(u * Math.PI) * bendStrength + u * zOffset;
      const x = bx - (1 - Math.cos(u * Math.PI * 0.35)) * Math.abs(bendStrength) * 0.12;
      pos.setXYZ(i, x, basePos[i * 3 + 1], z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /**
   * Switches between normal full-color shaded rendering and pure Black & White Alpha Matte
   * (white book silhouette on pure black background, zero lighting/shadows).
   */
  setAlphaMatte(enabled) {
    if (this.alphaMatte === enabled) return;
    this.alphaMatte = enabled;

    if (enabled) {
      this.savedMaterials.clear();
      this.scene.background = new THREE.Color(0x000000);
      this.scene.environment = null;
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.keyLight.castShadow = false;

      this.bookTransformGroup.traverse((obj) => {
        if (obj.isMesh) {
          this.savedMaterials.set(obj, obj.material);
          obj.material = this.matteMaterial;
        }
      });
    } else {
      this.scene.background = new THREE.Color(this.bgColor);
      this.scene.environment = this.envTex;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.keyLight.castShadow = this.shadowEnabled;

      this.bookTransformGroup.traverse((obj) => {
        if (obj.isMesh && this.savedMaterials.has(obj)) {
          obj.material = this.savedMaterials.get(obj);
        }
      });
      this.savedMaterials.clear();
    }
  }

  setBackgroundColor(hex) {
    this.bgColor = hex;
    if (!this.alphaMatte) {
      this.scene.background = new THREE.Color(hex);
    }
  }

  setShadowEnabled(enabled) {
    this.shadowEnabled = enabled;
    if (!this.alphaMatte) {
      this.keyLight.castShadow = enabled;
    }
  }

  setKeyLightIntensity(val) {
    this.keyLight.intensity = val;
  }

  setCameraDistance(dist) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.0001) dir.set(0, 0, 1);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  getCameraDistance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Renders a single deterministic frame at an arbitrary resolution (e.g., 3840x2160)
   * matching the exact framing inside the on-screen guide box via fovOverride.
   */
  renderFrameAtSize(width, height, fovOverride = null) {
    if (fovOverride !== null) {
      this.camera.fov = fovOverride;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
  }
}
