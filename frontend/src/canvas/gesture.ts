/**
 * gesture.ts — a mutable flag shared outside React.
 *
 * While the user is dragging or resizing a panel, everything else on screen
 * should get out of the way: the face drops to a cheaper update path, panel
 * contents stop re-rendering, transitions are suppressed. Routing that
 * through React state would defeat the point — the re-render is the thing we
 * are trying to avoid — so it lives in a plain object that the animation
 * loops poll directly.
 */
export const gesture = {
  /** True from pointerdown on a grip/handle until pointerup. */
  active: false,
};
