import type { ContactMapView } from "../App";
import { contactColorAt } from "../state/contactColor";
import { normalizeContactValue } from "../state/contactColorScale";
import { contactCellsForViewport } from "../state/contactMapView";
import { contactRenderGeometry } from "../state/contactRenderGeometry";
import type { UiState } from "../state/uiState";

interface CachedWebglState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
}

const webglStateByCanvas = new WeakMap<HTMLCanvasElement, CachedWebglState>();

export function drawContactMapWebgl(
  canvas: HTMLCanvasElement,
  contactMap: ContactMapView,
  uiState: UiState,
) {
  const state = getWebglState(canvas);
  if (!state) {
    return false;
  }
  const { gl, program } = state;

  const positions: number[] = [];
  const colors: number[] = [];
  const viewportWidth = Math.max(1, contactMap.viewport.xEnd - contactMap.viewport.xStart);
  const viewportHeight = Math.max(1, contactMap.viewport.yEnd - contactMap.viewport.yStart);
  const geometry = contactRenderGeometry({
    resolution: contactMap.resolution,
    viewportWidth,
    viewportHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
  const binWidth = (geometry.widthPx / Math.max(1, canvas.width)) * 2;
  const binHeight = (geometry.heightPx / Math.max(1, canvas.height)) * 2;
  for (const cell of contactCellsForViewport(contactMap)) {
    pushCell(
      positions,
      colors,
      uiState.contact.colormap,
      normalizeContactValue(cell.count, uiState.contact.colorScale),
      ((cell.xBin * contactMap.resolution - contactMap.viewport.xStart) / viewportWidth) * 2 - 1,
      1 - ((cell.yBin * contactMap.resolution - contactMap.viewport.yStart) / viewportHeight) * 2,
      binWidth,
      binHeight,
    );

    if (cell.xBin !== cell.yBin) {
      pushCell(
        positions,
        colors,
        uiState.contact.colormap,
        normalizeContactValue(cell.count, uiState.contact.colorScale),
        ((cell.yBin * contactMap.resolution - contactMap.viewport.xStart) / viewportWidth) * 2 - 1,
        1 - ((cell.xBin * contactMap.resolution - contactMap.viewport.yStart) / viewportHeight) * 2,
        binWidth,
        binHeight,
      );
    }
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  bindAttribute(gl, program, "a_position", positions, 2);
  bindAttribute(gl, program, "a_color", colors, 4);
  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
  return true;
}

function getWebglState(canvas: HTMLCanvasElement): CachedWebglState | null {
  const cached = webglStateByCanvas.get(canvas);
  if (cached) {
    return cached;
  }

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    return null;
  }

  const program = createProgram(gl);
  if (!program) {
    return null;
  }

  const state = { gl, program };
  webglStateByCanvas.set(canvas, state);
  return state;
}

function pushCell(
  positions: number[],
  colors: number[],
  colormap: UiState["contact"]["colormap"],
  intensity: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const right = x + width;
  const bottom = y - height;
  positions.push(x, y, right, y, x, bottom, x, bottom, right, y, right, bottom);

  const color = contactColorAt(colormap, intensity);
  for (let index = 0; index < 6; index += 1) {
    colors.push(color.red / 255, color.green / 255, color.blue / 255, color.alpha);
  }
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `
      attribute vec2 a_position;
      attribute vec4 a_color;
      varying vec4 v_color;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_color = a_color;
      }
    `,
  );
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
      precision mediump float;
      varying vec4 v_color;
      void main() {
        gl_FragColor = v_color;
      }
    `,
  );
  if (!vertexShader || !fragmentShader) {
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function bindAttribute(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
  values: number[],
  size: number,
) {
  const location = gl.getAttribLocation(program, name);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STREAM_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}
