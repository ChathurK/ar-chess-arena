/**
 * three-stub.mjs
 * ==============
 * A minimal stand-in for the parts of Three.js that the shared board modules
 * actually touch.
 *
 * WHY BOTHER
 * ----------
 * The interesting logic in `board-view.js` — working out which square an en
 * passant capture removes, noticing that a king moving two files means a rook
 * has to travel too, swapping a promoted pawn for a queen — has nothing to do
 * with rendering. Testing it through a real browser and a real WebGL context
 * would be slow, flaky and impossible in a headless environment; testing it
 * against a stub is instant and deterministic.
 *
 * The stub is deliberately faithful about STRUCTURE (parents, children,
 * userData, material colours) and deliberately empty about RENDERING. If the
 * board code ever starts depending on something real Three.js does that this
 * does not, the tests will fail loudly rather than quietly passing.
 */

class StubVector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  setScalar(value) {
    return this.set(value, value, value);
  }
  copy(other) {
    return this.set(other.x, other.y, other.z);
  }
}

class StubVector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
}

class StubColour {
  constructor(hex = 0xffffff) {
    this.hex = hex;
  }
  setHex(hex) {
    this.hex = hex;
    return this;
  }
  getHex() {
    return this.hex;
  }
}

class StubObject3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.name = '';
    this.userData = {};
    this.visible = true;
    this.position = new StubVector3();
    this.rotation = new StubVector3();
    this.scale = new StubVector3(1, 1, 1);
    this.isMesh = false;
  }
  add(child) {
    child.parent = this;
    this.children.push(child);
    return this;
  }
  remove(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return this;
  }
  traverse(visit) {
    visit(this);
    for (const child of [...this.children]) {
      child.traverse(visit);
    }
  }
  clone() {
    const copy = new this.constructor();
    copy.name = this.name;
    copy.userData = { ...this.userData };
    copy.position.copy(this.position);
    copy.rotation.copy(this.rotation);
    copy.scale.copy(this.scale);
    for (const child of this.children) {
      copy.add(child.clone());
    }
    return copy;
  }
}

class StubGroup extends StubObject3D {}

class StubMaterial {
  constructor(options = {}) {
    this.name = options.name ?? '';
    this.color = new StubColour(options.color ?? 0xffffff);
    this.roughness = options.roughness;
    this.metalness = options.metalness;
    this.wasDisposed = false;
  }
  clone() {
    // Real Three.js carries `name` across a material clone, and piece-loader.js
    // relies on that to tell a piece's accent from its body, so the stub has to
    // do it too or it would pass a test the browser fails.
    return new StubMaterial({ name: this.name, color: this.color.getHex() });
  }
  dispose() {
    this.wasDisposed = true;
  }
}

class StubMesh extends StubObject3D {
  constructor(geometry, material) {
    super();
    this.isMesh = true;
    this.geometry = geometry;
    this.material = material;
  }
  clone() {
    const copy = new StubMesh(this.geometry, this.material);
    copy.name = this.name;
    copy.userData = { ...this.userData };
    copy.position.copy(this.position);
    return copy;
  }
}

class StubGeometry {
  constructor(...dimensions) {
    this.dimensions = dimensions;
  }
}

class StubLight extends StubObject3D {
  constructor(...args) {
    super();
    this.args = args;
  }
}

class StubRaycaster {
  constructor() {
    this.ray = { origin: new StubVector3(), direction: new StubVector3() };
  }
  setFromCamera() {}
  intersectObject() {
    return [];
  }
}

export const THREE_STUB = {
  Group: StubGroup,
  Mesh: StubMesh,
  BoxGeometry: StubGeometry,
  RingGeometry: StubGeometry,
  MeshStandardMaterial: StubMaterial,
  MeshBasicMaterial: StubMaterial,
  Color: StubColour,
  Vector2: StubVector2,
  Vector3: StubVector3,
  Raycaster: StubRaycaster,
  HemisphereLight: StubLight,
  DirectionalLight: StubLight,
};

/**
 * A stand-in for PieceLoader that hands out structurally correct objects
 * without needing any .glb files or a GLTFLoader.
 */
export class StubPieceLoader {
  createPiece(pieceType, pieceColour) {
    const pieceObject = new StubGroup();
    const bodyMesh = new StubMesh(new StubGeometry(), new StubMaterial());
    pieceObject.add(bodyMesh);
    pieceObject.name = `piece_${pieceColour}${pieceType}`;
    pieceObject.userData.pieceType = pieceType;
    pieceObject.userData.pieceColour = pieceColour;
    return pieceObject;
  }
}
