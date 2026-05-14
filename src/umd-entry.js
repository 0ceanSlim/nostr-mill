/**
 * UMD entry point. Single default export so window.MILL = MILL directly,
 * not window.MILL = { default: MILL, ... }.
 * Named exports are still available on the MILL object as MILL.themes etc.
 */
import MILL from './mill-core.js';
export default MILL;
