// Values that change every frame live here, outside React state, so the scene can read them
// without re-rendering. dim eases toward the store's dimTarget (0 = 2D map, 1 = 3D city).
export const live = { dim: 1, homeScale: 1 };

export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const heightFor = (dim: number) => 0.07 + (1 - 0.07) * easeInOut(dim);

// A calm slate night (no purple neon): reads as a real neighborhood map, not a cyberpunk skyline.
export const HAZE = '#17232a';
export const GROUND = '#101a1f';
