import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  decodeClientBenchmarkDistribution,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';
import {
  denseFullNetworkGraph,
  maximumUniqueLinksPerCardWithinPlaintextLimit,
  measureFullNetworkPlacement,
  numericGraphChecksum,
  placeFullNetwork,
  representativeFullNetworkGraph,
  selectFullNetworkPlacementCandidate,
  semanticZoomFixtureCorpus,
  type FullNetworkNumericGraph,
  type FullNetworkPlacement,
} from '@/tests/benchmarks/full-network-semantic-zoom-support';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';

const branchPoint = '4341bed780b0fd2d797f5bef3505fd64c3670495';
const measuredIterations = 3;

type BrowserGraphInput = Readonly<{
  name: string;
  nodeCount: number;
  edgeMode:
    | Readonly<{
        kind: 'explicit';
        sources: readonly number[];
        targets: readonly number[];
      }>
    | Readonly<{ kind: 'dense'; linksPerNode: number }>;
  x: readonly number[];
  y: readonly number[];
  width: number;
  height: number;
}>;

function placementChecksum(placement: FullNetworkPlacement): number {
  let checksum = placement.componentCount * 31;
  for (let node = 0; node < placement.x.length; node += 1) {
    const x = placement.x[node];
    const y = placement.y[node];
    if (x === undefined || y === undefined) {
      throw new Error(`Placement omitted node ${node}`);
    }
    checksum = (checksum * 33 + Math.round(x) * 17 + Math.round(y)) >>> 0;
  }
  return checksum;
}

function measurePlacement(
  graph: FullNetworkNumericGraph,
  candidate: FullNetworkPlacement['candidate'],
) {
  const before = numericGraphChecksum(graph);
  const warmup = placeFullNetwork(graph, candidate);
  const expectedChecksum = placementChecksum(warmup);
  const samples: number[] = [];
  const memoryBefore = process.memoryUsage();
  let finalPlacement = warmup;
  for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
    const started = performance.now();
    finalPlacement = placeFullNetwork(graph, candidate);
    samples.push(performance.now() - started);
    if (placementChecksum(finalPlacement) !== expectedChecksum) {
      throw new Error(`${graph.name}/${candidate} returned unstable geometry`);
    }
  }
  const memoryAfter = process.memoryUsage();
  if (numericGraphChecksum(graph) !== before) {
    throw new Error(`${graph.name}/${candidate} mutated its graph input`);
  }
  return {
    graph: graph.name,
    candidate,
    warmupIterations: 1,
    measuredIterations,
    timing: decodeClientBenchmarkDistribution(
      summarizeClientBenchmarkSamples(samples),
    ),
    observedProcessMemoryDeltaBytes: {
      heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed,
      arrayBuffers: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
      rss: memoryAfter.rss - memoryBefore.rss,
    },
    placement: finalPlacement,
    metrics: measureFullNetworkPlacement(graph, finalPlacement),
  };
}

function measureStructuredClone(graph: FullNetworkNumericGraph) {
  const samples: number[] = [];
  for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
    const started = performance.now();
    const copy = structuredClone({
      nodeCount: graph.nodeCount,
      sources: graph.sources,
      targets: graph.targets,
    });
    samples.push(performance.now() - started);
    if (
      copy.nodeCount !== graph.nodeCount ||
      copy.sources.length !== graph.sources.length ||
      copy.targets.length !== graph.targets.length
    ) {
      throw new Error(`${graph.name} structured clone omitted graph identity`);
    }
  }
  return {
    graph: graph.name,
    payloadBytes: graph.sources.byteLength + graph.targets.byteLength,
    semantics: 'structured clone copy; transferable ownership is not claimed',
    timing: decodeClientBenchmarkDistribution(
      summarizeClientBenchmarkSamples(samples),
    ),
  };
}

async function measureBrowserRenderer(input: BrowserGraphInput) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1_280, height: 720 },
    });
    await page.setContent(
      '<canvas id="graph" width="1280" height="720" aria-label="benchmark"></canvas>',
    );
    return await page.evaluate(async (graph) => {
      const valueAt = (values: readonly number[], index: number): number => {
        const value = values[index];
        if (value === undefined) throw new Error(`Missing value ${index}`);
        return value;
      };
      const summarize = (values: readonly number[]) => {
        const rounded = (value: number): number => Number(value.toFixed(3));
        const sorted = [...values].sort((left, right) => left - right);
        const percentile = (proportion: number): number => {
          const index = Math.max(
            0,
            Math.min(
              sorted.length - 1,
              Math.ceil(sorted.length * proportion) - 1,
            ),
          );
          return valueAt(sorted, index);
        };
        return {
          minimumMs: rounded(valueAt(sorted, 0)),
          medianMs: rounded(percentile(0.5)),
          p95Ms: rounded(percentile(0.95)),
          maximumMs: rounded(valueAt(sorted, sorted.length - 1)),
          samplesMs: values.map(rounded),
        };
      };
      const sources: number[] = [];
      const targets: number[] = [];
      if (graph.edgeMode.kind === 'explicit') {
        sources.push(...graph.edgeMode.sources);
        targets.push(...graph.edgeMode.targets);
      } else {
        const stride = graph.nodeCount <= 2 ? 1 : 7_919 % graph.nodeCount || 1;
        for (let source = 0; source < graph.nodeCount; source += 1) {
          const used = new Set<number>();
          for (let link = 0; link < graph.edgeMode.linksPerNode; link += 1) {
            let target = (source + 1 + link * stride) % graph.nodeCount;
            while (target === source || used.has(target)) {
              target = (target + 1) % graph.nodeCount;
            }
            used.add(target);
            sources.push(source);
            targets.push(target);
          }
        }
      }
      if (sources.length !== targets.length) {
        throw new Error('Renderer input edge arrays differ in length');
      }
      const canvasElement = document.querySelector('#graph');
      if (!(canvasElement instanceof HTMLCanvasElement)) {
        throw new Error('Benchmark canvas is unavailable');
      }
      const workerCapability = await new Promise<
        Readonly<{ offscreenCanvas: boolean; webgl2: boolean }>
      >((resolve, reject) => {
        const source = `self.onmessage = () => {
          const offscreenCanvas = typeof OffscreenCanvas === 'function';
          let webgl2 = false;
          if (offscreenCanvas) {
            const canvas = new OffscreenCanvas(2, 2);
            webgl2 = canvas.getContext('webgl2') !== null;
          }
          self.postMessage({ offscreenCanvas, webgl2 });
        };`;
        const url = URL.createObjectURL(
          new Blob([source], { type: 'text/javascript' }),
        );
        const worker = new Worker(url);
        const cleanup = (): void => {
          worker.terminate();
          URL.revokeObjectURL(url);
        };
        worker.onerror = () => {
          cleanup();
          reject(new Error('OffscreenCanvas capability worker failed'));
        };
        worker.onmessage = (event: MessageEvent<unknown>) => {
          const data = event.data;
          cleanup();
          if (
            typeof data !== 'object' ||
            data === null ||
            typeof Reflect.get(data, 'offscreenCanvas') !== 'boolean' ||
            typeof Reflect.get(data, 'webgl2') !== 'boolean'
          ) {
            reject(new Error('Capability worker returned invalid data'));
            return;
          }
          resolve({
            offscreenCanvas: Reflect.get(data, 'offscreenCanvas') === true,
            webgl2: Reflect.get(data, 'webgl2') === true,
          });
        };
        worker.postMessage(null);
      });
      const scaleX = 2 / Math.max(1, graph.width);
      const scaleY = 2 / Math.max(1, graph.height);
      const clipX = (node: number): number =>
        valueAt(graph.x, node) * scaleX - 1;
      const clipY = (node: number): number =>
        1 - valueAt(graph.y, node) * scaleY;
      const pixelX = (node: number): number =>
        (valueAt(graph.x, node) / Math.max(1, graph.width)) * 1_280;
      const pixelY = (node: number): number =>
        (valueAt(graph.y, node) / Math.max(1, graph.height)) * 720;
      const measure = (draw: () => void): number[] => {
        draw();
        const samples: number[] = [];
        for (let iteration = 0; iteration < 3; iteration += 1) {
          const started = performance.now();
          draw();
          samples.push(performance.now() - started);
        }
        return samples;
      };
      const measureFrameGaps = async (draw: () => void): Promise<number[]> => {
        const samples: number[] = [];
        for (let iteration = 0; iteration < 3; iteration += 1) {
          const sample = await new Promise<number>((resolve) => {
            requestAnimationFrame(() => {
              const started = performance.now();
              draw();
              requestAnimationFrame(() => resolve(performance.now() - started));
            });
          });
          samples.push(sample);
        }
        return samples;
      };
      const measureRetainedCameraFrameGaps = async (
        canvas: HTMLCanvasElement,
      ): Promise<number[]> => {
        canvas.style.transformOrigin = '0 0';
        canvas.style.willChange = 'transform';
        const samples: number[] = [];
        for (let iteration = 0; iteration < 4; iteration += 1) {
          const sample = await new Promise<number>((resolve) => {
            requestAnimationFrame(() => {
              const started = performance.now();
              canvas.style.transform = `translate3d(${iteration + 1}px, ${iteration + 1}px, 0) scale(1.001)`;
              requestAnimationFrame(() => resolve(performance.now() - started));
            });
          });
          if (iteration > 0) samples.push(sample);
        }
        return samples;
      };

      const canvas2d = canvasElement;
      const context2d = canvas2d.getContext('2d');
      if (!context2d) throw new Error('Canvas2D is unavailable');
      const drawCanvas = (): void => {
        context2d.clearRect(0, 0, 1_280, 720);
        context2d.beginPath();
        for (let edge = 0; edge < sources.length; edge += 1) {
          const source = valueAt(sources, edge);
          const target = valueAt(targets, edge);
          context2d.moveTo(pixelX(source), pixelY(source));
          context2d.lineTo(pixelX(target), pixelY(target));
        }
        context2d.stroke();
        for (let node = 0; node < graph.nodeCount; node += 1) {
          context2d.fillRect(pixelX(node), pixelY(node), 1, 1);
        }
      };
      const canvasSamples = measure(drawCanvas);
      const canvasFrameGaps = await measureFrameGaps(drawCanvas);
      const canvasCameraFrameGaps =
        await measureRetainedCameraFrameGaps(canvas2d);

      const webglCanvas = document.createElement('canvas');
      webglCanvas.width = 1_280;
      webglCanvas.height = 720;
      canvas2d.replaceWith(webglCanvas);
      const gl = webglCanvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) {
        return {
          graph: graph.name,
          nodeCount: graph.nodeCount,
          edgeCount: sources.length,
          workerCapability,
          canvas2d: {
            draw: summarize(canvasSamples),
            fullRedrawFrameGap: summarize(canvasFrameGaps),
            retainedCameraFrameGap: summarize(canvasCameraFrameGaps),
            backingStoreBytes: 1_280 * 720 * 4,
          },
          webgl2: { supported: false as const },
        };
      }
      const webglString = (parameter: number): string => {
        const value: unknown = gl.getParameter(parameter);
        return typeof value === 'string' ? value : 'unknown';
      };
      gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = {
        vendor: webglString(gl.VENDOR),
        renderer: webglString(gl.RENDERER),
        unmaskedVendor: webglString(37_445),
        unmaskedRenderer: webglString(37_446),
      };
      const compileShader = (type: number, source: string): WebGLShader => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Unable to allocate WebGL shader');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader failed');
        }
        return shader;
      };
      const program = gl.createProgram();
      if (!program) throw new Error('Unable to allocate WebGL program');
      gl.attachShader(
        program,
        compileShader(
          gl.VERTEX_SHADER,
          '#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0,1);gl_PointSize=1.0;}',
        ),
      );
      gl.attachShader(
        program,
        compileShader(
          gl.FRAGMENT_SHADER,
          '#version 300 es\nprecision mediump float; out vec4 color; void main(){color=vec4(0.1,0.2,0.3,0.35);}',
        ),
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'Program failed');
      }
      gl.useProgram(program);
      const positionLocation = gl.getAttribLocation(program, 'position');
      if (positionLocation < 0) throw new Error('Position attribute is absent');
      const edgeVertices = new Float32Array(sources.length * 4);
      for (let edge = 0; edge < sources.length; edge += 1) {
        const source = valueAt(sources, edge);
        const target = valueAt(targets, edge);
        const offset = edge * 4;
        edgeVertices[offset] = clipX(source);
        edgeVertices[offset + 1] = clipY(source);
        edgeVertices[offset + 2] = clipX(target);
        edgeVertices[offset + 3] = clipY(target);
      }
      const nodeVertices = new Float32Array(graph.nodeCount * 2);
      for (let node = 0; node < graph.nodeCount; node += 1) {
        nodeVertices[node * 2] = clipX(node);
        nodeVertices[node * 2 + 1] = clipY(node);
      }
      const edgeBuffer = gl.createBuffer();
      const nodeBuffer = gl.createBuffer();
      if (!edgeBuffer || !nodeBuffer) {
        throw new Error('Unable to allocate WebGL buffers');
      }
      const uploadSamples: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const started = performance.now();
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, edgeVertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, nodeVertices, gl.STATIC_DRAW);
        gl.finish();
        uploadSamples.push(performance.now() - started);
      }
      const drawWebgl = (): void => {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, sources.length * 2);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffer);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, graph.nodeCount);
        gl.finish();
      };
      const webglSamples = measure(drawWebgl);
      const webglFrameGaps = await measureFrameGaps(drawWebgl);
      const webglCameraFrameGaps =
        await measureRetainedCameraFrameGaps(webglCanvas);
      return {
        graph: graph.name,
        nodeCount: graph.nodeCount,
        edgeCount: sources.length,
        workerCapability,
        canvas2d: {
          draw: summarize(canvasSamples),
          fullRedrawFrameGap: summarize(canvasFrameGaps),
          retainedCameraFrameGap: summarize(canvasCameraFrameGaps),
          retainedGeometryBytes: 0,
          backingStoreBytes: 1_280 * 720 * 4,
        },
        webgl2: {
          supported: true as const,
          renderer,
          upload: summarize(uploadSamples),
          draw: summarize(webglSamples),
          fullRedrawFrameGap: summarize(webglFrameGaps),
          retainedCameraFrameGap: summarize(webglCameraFrameGaps),
          retainedGeometryBytes:
            edgeVertices.byteLength + nodeVertices.byteLength,
          backingStoreBytes: 1_280 * 720 * 4,
        },
      };
    }, input);
  } finally {
    await browser.close();
  }
}

function browserInput(
  graph: FullNetworkNumericGraph,
  placement: FullNetworkPlacement,
  edgeMode: BrowserGraphInput['edgeMode'],
): BrowserGraphInput {
  return {
    name: graph.name,
    nodeCount: graph.nodeCount,
    edgeMode,
    x: [...placement.x],
    y: [...placement.y],
    width: placement.width,
    height: placement.height,
  };
}

describe('full-network semantic zoom benchmark artifact', () => {
  it('measures all-card/all-link candidates without a host timing gate', async () => {
    const linkEnvelope = maximumUniqueLinksPerCardWithinPlaintextLimit();
    const representative = representativeFullNetworkGraph(
      createClientPerformanceFixture(),
    );
    const dense = denseFullNetworkGraph(10_000, linkEnvelope.links);
    expect(representative.nodeCount).toBe(10_000);
    expect(representative.sources.length).toBe(19_951);
    expect(dense.nodeCount).toBe(10_000);
    expect(dense.sources.length).toBe(1_160_000);

    const corpus = semanticZoomFixtureCorpus().map((graph) => {
      const placement = placeFullNetwork(graph, 'component-bfs-serpentine');
      return measureFullNetworkPlacement(graph, placement);
    });
    const layouts = [
      measurePlacement(representative, 'identity-serpentine'),
      measurePlacement(representative, 'component-bfs-serpentine'),
      measurePlacement(representative, 'component-dfs-serpentine'),
      measurePlacement(dense, 'identity-serpentine'),
      measurePlacement(dense, 'component-bfs-serpentine'),
      measurePlacement(dense, 'component-dfs-serpentine'),
    ];
    const candidateDecision = selectFullNetworkPlacementCandidate(
      layouts.map((measurement) => ({
        graph: measurement.graph,
        metrics: measurement.metrics,
      })),
    );
    const selectedRepresentative = layouts.find(
      (measurement) =>
        measurement.graph === representative.name &&
        measurement.candidate === candidateDecision.selected,
    )?.placement;
    const selectedDense = layouts.find(
      (measurement) =>
        measurement.graph === dense.name &&
        measurement.candidate === candidateDecision.selected,
    )?.placement;
    if (!selectedRepresentative || !selectedDense) {
      throw new Error('Benchmark omitted selected placements');
    }
    const browser = [
      await measureBrowserRenderer(
        browserInput(representative, selectedRepresentative, {
          kind: 'explicit',
          sources: [...representative.sources],
          targets: [...representative.targets],
        }),
      ),
      await measureBrowserRenderer(
        browserInput(dense, selectedDense, {
          kind: 'dense',
          linksPerNode: linkEnvelope.links,
        }),
      ),
    ];
    const artifact = {
      schemaVersion: 1,
      issue: 285,
      branchPoint,
      generatedAt: new Date().toISOString(),
      host: {
        platform: platform(),
        release: release(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        node: process.version,
        chromium:
          browser.length === 2 ? 'Playwright bundled Chromium' : 'unknown',
      },
      policy: {
        timing: 'raw evidence only; no host-dependent pass/fail threshold',
        crossingMetric: 'deterministic sample of at most 2,000 edges',
        nodeIntrusionMetric:
          'deterministic sample of at most 200 edges against every non-endpoint node; 3 world-unit radius',
        displaySampling: false,
      },
      quotaDerivedEnvelope: {
        activeCards: 10_000,
        serializedPlaintextBytesPerCard: 8_192,
        ...linkEnvelope,
        directedEdges: dense.sources.length,
      },
      graphs: {
        representative: {
          nodes: representative.nodeCount,
          directedEdges: representative.sources.length,
          typedInputBytes:
            representative.sources.byteLength +
            representative.targets.byteLength,
        },
        dense: {
          nodes: dense.nodeCount,
          directedEdges: dense.sources.length,
          typedInputBytes: dense.sources.byteLength + dense.targets.byteLength,
        },
      },
      corpus,
      layouts: layouts.map(
        ({ placement: _placement, ...measurement }) => measurement,
      ),
      candidateDecision,
      workerBoundary: [
        measureStructuredClone(representative),
        measureStructuredClone(dense),
      ],
      renderer: browser,
      dependencyAndBundle: {
        newRuntimeDependencies: [],
        productionBundleBytesAddedByBenchmarkPr: 0,
        existingLayoutDependency: {
          name: 'elkjs',
          version: '0.12.0',
          license: 'EPL-2.0 OR GPL-3.0-or-later',
          disposition:
            'retain for current bounded detail view; do not use for global 10k placement',
        },
      },
    };
    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/full-network-semantic-zoom.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  }, 600_000);
});
