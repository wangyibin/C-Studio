import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { exportAgpText } from "./state/agpExport";
import {
  contactCountSampleForColorScale,
  estimateContactColorScale,
  type ContactColorScale,
} from "./state/contactColorScale";
import { displayContactMapForPendingLayer } from "./state/contactMapView";
import { contactResolutionToBasePairs } from "./state/contactResolution";
import { buildCenteredContactViewport } from "./state/contactViewport";
import {
  buildBrowserCoverageView,
  buildCoverageViewRequest,
  parseBedGraphText,
  type BedGraphRecord,
  type CoverageView,
} from "./state/coverageView";
import {
  contactTileCacheKey,
  contactTileScope,
  contactTileSizeBins,
} from "./state/contactTiles";
import {
  buildContactTileLoadPlan,
  buildContactTileWorld,
  projectContactTileWorldView,
} from "./state/contactTileWorld";
import {
  normalizeImportedAgpLayout,
  parseAgpLayout,
  type AgpLayout,
  type ContactMapLayoutBlock,
  summarizeAgpText,
} from "./state/importers";
import { summarizePafText } from "./state/pafPreview";
import { buildBrowserSyntenyView, buildSyntenyViewRequest, type SyntenyView } from "./state/syntenyView";
import { createInitialUiState, reduceUiState, type ContactResolution } from "./state/uiState";

export interface AppStatus {
  engine: string;
  coordinate_convention: string;
  supported_operations: string[];
}

export interface ExampleDatasetSummary {
  agp_path: string;
  mcool_path: string;
  agp_lines: number;
  agp_objects: number;
  agp_components: number;
  agp_gaps: number;
  max_object_span: number;
  mcool_size_bytes: number;
  coverage_path: string | null;
  agp_layout: AgpLayout;
  cool_path: string;
}

export interface ContactMapCell {
  xBin: number;
  yBin: number;
  count: number;
}

export interface ContactMapView {
  resolution: number;
  viewport: {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
  };
  cells: ContactMapCell[];
  tileSizeBins?: number;
  tiles?: ContactMapTile[];
  cachedTiles?: ContactMapTile[];
  /** Layout snapshot used to produce this visual layer. */
  layoutBlocks?: ContactMapLayoutBlock[];
  layoutScope?: string;
}

export interface ContactMapTile {
  tileX: number;
  tileY: number;
  cells: ContactMapCell[];
}

export interface ContactMapTileKey {
  tileX: number;
  tileY: number;
}

interface ImportedContactFile {
  path: string;
  name: string;
  size_bytes: number;
}

const samplePaf = [
  "ctg00003\t1400000\t120000\t760000\t+\tchrA\t2200000\t240000\t900000\t600000\t640000\t60",
  "ctg00008\t960000\t180000\t620000\t-\tchrA\t2200000\t1040000\t1500000\t390000\t440000\t48",
  "ctg00012\t780000\t60000\t410000\t+\tchrB\t1600000\t260000\t620000\t300000\t350000\t35",
].join("\n");

const browserFallbackStatus: AppStatus = {
  engine: "cstudio-core",
  coordinate_convention: "0-based half-open internal; 1-based closed AGP",
  supported_operations: ["split", "move", "flip", "copy"],
};
const emptyLayout: AgpLayout = { blocks: [], totalSpan: 0 };
const maxBackgroundPrefetchTiles = 16;
const contactTileRequestBatchSize = 16;
const contactViewportRequestDelayMs = 24;
const secondaryTrackRequestDelayMs = 180;
const maxFrontendContactTiles = 96;
const maxFrontendContactCells = 750_000;

export function App() {
  const [status, setStatus] = useState<AppStatus>(browserFallbackStatus);
  const [dataset, setDataset] = useState<ExampleDatasetSummary | null>(null);
  const [contactMap, setContactMap] = useState<ContactMapView | null>(null);
  const [overviewContactMap, setOverviewContactMap] = useState<ContactMapView | null>(null);
  const [contactTileCache, setContactTileCache] = useState<Map<string, ContactMapTile>>(new Map());
  const contactTileCacheRef = useRef(contactTileCache);
  const autoColorScaleCacheRef = useRef<Map<string, ContactColorScale>>(new Map());
  const lastDrawableContactMapRef = useRef<ContactMapView | null>(null);
  const contactTileRequestIdRef = useRef(0);
  const [syntenyView, setSyntenyView] = useState<SyntenyView | null>(null);
  const [coverageView, setCoverageView] = useState<CoverageView | null>(null);
  const [coverageRecords, setCoverageRecords] = useState<BedGraphRecord[]>([]);
  const [pafText, setPafText] = useState(samplePaf);
  const [pafPath, setPafPath] = useState<string | null>(null);
  const [pafImported, setPafImported] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Workbench ready");
  const agpInputRef = useRef<HTMLInputElement>(null);
  const pafInputRef = useRef<HTMLInputElement>(null);
  const coverageInputRef = useRef<HTMLInputElement>(null);
  const [uiState, dispatchUi] = useReducer(
    reduceUiState,
    createInitialUiState("Workbench ready"),
  );
  const assemblyBlocks = uiState.assembly.blocks.length > 0
    ? uiState.assembly.blocks
    : dataset?.agp_layout.blocks ?? emptyLayout.blocks;
  const assemblyLayout = useMemo(
    () =>
      dataset
        ? { blocks: assemblyBlocks, totalSpan: totalVisualSpan(assemblyBlocks, dataset.agp_layout.totalSpan) }
        : emptyLayout,
    [assemblyBlocks, dataset],
  );
  const backgroundAssemblyLayout = useDebouncedValue(assemblyLayout, secondaryTrackRequestDelayMs);

  useEffect(() => {
    invoke<AppStatus>("get_app_status")
      .then((nextStatus) => {
        setStatus(nextStatus);
        setStatusMessage("Backend connected");
      })
      .catch(() => {
        setStatus(browserFallbackStatus);
        setStatusMessage("Browser preview mode");
      });
  }, []);

  useEffect(() => {
    contactTileCacheRef.current = contactTileCache;
  }, [contactTileCache]);

  useEffect(() => {
    const emptyTileCache = new Map<string, ContactMapTile>();
    contactTileCacheRef.current = emptyTileCache;
    autoColorScaleCacheRef.current.clear();
    setContactTileCache(emptyTileCache);
    lastDrawableContactMapRef.current = null;
  }, [dataset?.cool_path]);

  useEffect(() => {
    if (!dataset?.cool_path || assemblyLayout.blocks.length === 0) {
      setContactMap((current) => (current === null ? current : null));
      setContactTileCache((current) => (current.size === 0 ? current : new Map()));
      lastDrawableContactMapRef.current = null;
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const targetResolution = resolutionToBasePairs(uiState.contact.resolution);
      const totalSpanBp = Math.max(targetResolution, assemblyLayout.totalSpan);
      const viewport = buildCenteredContactViewport({
        centerMb: uiState.contact.viewportCenterMb,
        centerXMb: uiState.contact.viewportCenterXMb,
        centerYMb: uiState.contact.viewportCenterYMb,
        totalSpanBp,
        windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
        viewportWidthPx: uiState.contact.viewportWidthPx,
        viewportHeightPx: uiState.contact.viewportHeightPx,
      });
      const tileSizeBins = contactTileSizeBins;
      const tileScope = contactTileScope(
        dataset.cool_path,
        targetResolution,
        tileSizeBins,
        assemblyLayout.blocks,
      );
      const autoColorScaleKey = [
        tileScope,
        uiState.normalization,
        uiState.contact.colorScale.log ? "log" : "linear",
      ].join("|");
      const applyAutoColorScale = (map: ContactMapView) => {
        if (!uiState.contact.colorScale.auto || !hasContactMapData(map)) {
          return;
        }

        const cachedScale = autoColorScaleCacheRef.current.get(autoColorScaleKey);
        if (cachedScale) {
          dispatchUi({ type: "setAutoColorScale", scale: cachedScale });
          return;
        }

        const counts = contactCountSampleForColorScale(map);
        if (!counts.some((value) => Number.isFinite(value) && value > 0)) {
          return;
        }
        const scale = estimateContactColorScale(counts, uiState.contact.colorScale.log);
        autoColorScaleCacheRef.current.set(autoColorScaleKey, scale);
        dispatchUi({ type: "setAutoColorScale", scale });
      };
      const currentCache = contactTileCacheRef.current;
      const tileWorld = buildContactTileWorld({
        viewport,
        resolution: targetResolution,
        tileSizeBins,
        scope: tileScope,
        cache: currentCache,
      });
      const pendingContactMap: ContactMapView = {
        ...projectContactTileWorldView(tileWorld),
        layoutBlocks: assemblyLayout.blocks,
        layoutScope: tileScope,
      };
      const nextContactMap = displayContactMapForPendingLayer(
        pendingContactMap,
        lastDrawableContactMapRef.current,
        tileWorld.missingVisibleTiles.length === 0,
      );
      if (nextContactMap === pendingContactMap) {
        lastDrawableContactMapRef.current = pendingContactMap;
      }

      setContactMap(nextContactMap);
      if (
        tileWorld.missingVisibleTiles.length === 0
      ) {
        applyAutoColorScale(pendingContactMap);
      }

      const loadPlan = buildContactTileLoadPlan(
        tileWorld,
        maxBackgroundPrefetchTiles,
        contactTileRequestBatchSize,
      );
      const tileBatches = [
        ...loadPlan.visibleBatches.map((tiles) => ({ kind: "visible" as const, tiles })),
        ...loadPlan.prefetchBatches.map((tiles) => ({ kind: "prefetch" as const, tiles })),
      ];

      if (tileBatches.length === 0) {
        contactTileRequestIdRef.current += 1;
        setStatusMessage(
          `Contact map rendered at ${uiState.contact.resolution}, ${formatViewportLabel(viewport)}`,
        );
        return;
      }

      const requestId = contactTileRequestIdRef.current + 1;
      contactTileRequestIdRef.current = requestId;
      let visibleReady = loadPlan.visibleBatches.length === 0;
      if (visibleReady) {
        setStatusMessage(
          `Contact map rendered at ${uiState.contact.resolution}, ${formatViewportLabel(viewport)}`,
        );
      }
      void (async () => {
        for (const batch of tileBatches) {
          const tiles = await invoke<ContactMapTile[]>("get_contact_map_tiles_from_cool", {
            request: {
              coolPath: dataset.cool_path,
              baseResolution: 1000,
              targetResolution,
              tileSizeBins,
              tiles: batch.tiles,
              layoutBlocks: assemblyLayout.blocks,
            },
          });
          if (cancelled || requestId !== contactTileRequestIdRef.current) {
            return;
          }

          const nextCache = new Map(contactTileCacheRef.current);
          for (const tile of tiles) {
            nextCache.set(contactTileCacheKey(tileScope, tile), tile);
          }
          trimContactTileCache(nextCache, tileScope);
          contactTileCacheRef.current = nextCache;
          setContactTileCache(nextCache);

          const updatedTileWorld = buildContactTileWorld({
            viewport,
            resolution: targetResolution,
            tileSizeBins,
            scope: tileScope,
            cache: nextCache,
          });
          const updatedContactMap: ContactMapView = {
            ...projectContactTileWorldView(updatedTileWorld),
            layoutBlocks: assemblyLayout.blocks,
            layoutScope: tileScope,
          };
          const displayedContactMap = displayContactMapForPendingLayer(
            updatedContactMap,
            lastDrawableContactMapRef.current,
            updatedTileWorld.missingVisibleTiles.length === 0,
          );
          if (displayedContactMap === updatedContactMap) {
            lastDrawableContactMapRef.current = updatedContactMap;
          }
          setContactMap(displayedContactMap);

          if (batch.kind === "visible" && updatedTileWorld.missingVisibleTiles.length === 0) {
            visibleReady = true;
            setStatusMessage(
              `Contact map rendered at ${uiState.contact.resolution}, ${formatViewportLabel(viewport)}`,
            );
          }
          if (
            batch.kind === "visible"
            && updatedTileWorld.missingVisibleTiles.length === 0
          ) {
            applyAutoColorScale(updatedContactMap);
          }
        }
      })().catch((error) => {
        if (cancelled || requestId !== contactTileRequestIdRef.current) {
          return;
        }
        if (!visibleReady) {
          setStatusMessage(`Contact map render failed: ${String(error)}`);
        }
        dispatchUi({
          type: "appendLog",
          message: `${visibleReady ? "Contact prefetch" : "Contact map render"} failed: ${String(error)}`,
        });
      });
    }, contactViewportRequestDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    dataset,
    assemblyLayout,
    uiState.contact.resolution,
    uiState.contact.viewportCenterMb,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportCenterYMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
    uiState.contact.colorScale.auto,
    uiState.contact.colorScale.log,
    uiState.normalization,
  ]);

  useEffect(() => {
    if (!dataset?.cool_path || backgroundAssemblyLayout.blocks.length === 0) {
      setOverviewContactMap(null);
      return;
    }

    let cancelled = false;
    const totalSpanBp = Math.max(1, backgroundAssemblyLayout.totalSpan);
    const targetResolution = overviewResolutionForSpan(totalSpanBp);
    invoke<ContactMapView>("build_contact_map_view_from_cool", {
      request: {
        coolPath: dataset.cool_path,
        baseResolution: 1000,
        targetResolution,
        viewport: {
          xStart: 0,
          xEnd: totalSpanBp,
          yStart: 0,
          yEnd: totalSpanBp,
        },
        layoutBlocks: backgroundAssemblyLayout.blocks,
      },
    })
      .then((overviewMap) => {
        if (!cancelled) {
          setOverviewContactMap(overviewMap);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setOverviewContactMap(null);
          dispatchUi({ type: "appendLog", message: `Overview heatmap load failed: ${String(error)}` });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dataset?.cool_path, backgroundAssemblyLayout]);

  useEffect(() => {
    if (backgroundAssemblyLayout.blocks.length === 0 || (!dataset?.coverage_path && coverageRecords.length === 0)) {
      setCoverageView(null);
      return;
    }

    let cancelled = false;
    const totalSpanBp = Math.max(1, backgroundAssemblyLayout.totalSpan);
    const viewport = buildCenteredContactViewport({
      centerMb: uiState.contact.viewportCenterXMb,
      centerXMb: uiState.contact.viewportCenterXMb,
      totalSpanBp,
      windowSizeBp: uiState.contact.viewportSpanMb * 1_000_000,
      viewportWidthPx: uiState.contact.viewportWidthPx,
      viewportHeightPx: uiState.contact.viewportHeightPx,
    });
    const request = buildCoverageViewRequest(
      coverageRecords,
      backgroundAssemblyLayout.blocks,
      totalSpanBp,
      {
        displayResolution: contactResolutionToBasePairs(uiState.contact.resolution),
        viewport,
      },
    );
    const coveragePromise = coverageRecords.length > 0
      ? invoke<CoverageView>("build_coverage_view", { request })
      : invoke<CoverageView>("build_coverage_view_from_bedgraph", {
          request: {
            bedgraphPath: dataset?.coverage_path,
            displayResolution: request.displayResolution,
            viewport: request.viewport,
            layoutBlocks: request.layoutBlocks,
          },
        });

    coveragePromise
      .then((view) => {
        if (!cancelled) {
          setCoverageView(view);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (coverageRecords.length > 0) {
          setCoverageView(buildBrowserCoverageView(request));
          return;
        }
        setCoverageView(null);
        dispatchUi({ type: "appendLog", message: `Coverage load failed: ${String(error)}` });
      });

    return () => {
      cancelled = true;
    };
  }, [
    backgroundAssemblyLayout,
    coverageRecords,
    dataset?.coverage_path,
    uiState.contact.resolution,
    uiState.contact.viewportCenterXMb,
    uiState.contact.viewportSpanMb,
    uiState.contact.viewportWidthPx,
    uiState.contact.viewportHeightPx,
  ]);

  useEffect(() => {
    if (!backgroundAssemblyLayout.blocks.length || (!pafPath && !pafText.trim())) {
      setSyntenyView(null);
      return;
    }

    let cancelled = false;
    const request = buildSyntenyViewRequest({
      pafText: pafPath ? "" : pafText,
      centerMb: uiState.contact.viewportCenterMb,
      totalSpanBp: Math.max(1, backgroundAssemblyLayout.totalSpan),
      layoutBlocks: backgroundAssemblyLayout.blocks,
    });

    if (!pafPath && request.pafRecords.length === 0) {
      setSyntenyView(null);
      return;
    }

    const syntenyPromise = pafPath
      ? invoke<SyntenyView>("build_synteny_view_from_paf", {
          request: {
            pafPath,
            viewport: request.viewport,
            layoutBlocks: request.layoutBlocks,
            minMapq: request.minMapq,
            minAlignmentLen: request.minAlignmentLen,
            maxQueryGap: request.maxQueryGap,
            maxTargetGap: request.maxTargetGap,
          },
        })
      : invoke<SyntenyView>("build_synteny_view", { request });

    syntenyPromise
      .then((view) => {
        if (!cancelled) {
          setSyntenyView(view);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        if (!pafPath) {
          setSyntenyView(buildBrowserSyntenyView(request));
          return;
        }
        setSyntenyView(null);
        dispatchUi({ type: "appendLog", message: `PAF load failed: ${String(error)}` });
      });

    return () => {
      cancelled = true;
    };
  }, [backgroundAssemblyLayout, pafPath, pafText, uiState.contact.viewportCenterMb]);

  async function loadExamples() {
    try {
      const summary = await invoke<ExampleDatasetSummary>("load_example_dataset");
      const importedDataset = ensureImportedDataset(summary);
      setDataset(importedDataset);
      dispatchUi({ type: "setAssemblyBlocks", blocks: importedDataset.agp_layout.blocks });
      setStatusMessage("Example dataset loaded");
      dispatchUi({ type: "appendLog", message: "Example dataset loaded" });
    } catch {
      const summary = await loadBrowserExampleSummary();
      setDataset(summary);
      dispatchUi({ type: "setAssemblyBlocks", blocks: summary.agp_layout.blocks });
      setStatusMessage("Example AGP loaded in browser preview");
      dispatchUi({ type: "appendLog", message: "Example AGP loaded in browser preview" });
    }
  }

  async function importAgpFile(file: File) {
    const text = await file.text();
    const summary = summarizeAgpText(text);
    const agpLayout = parseAgpLayout(text);

    setDataset((current) => ({
      ...buildDatasetSummary({
        agpPath: file.name,
        mcoolPath: current?.mcool_path ?? "",
        coolPath: current?.cool_path ?? "",
        agpLines: summary.lineCount,
        agpObjects: summary.objectCount,
        agpComponents: summary.componentCount,
        agpGaps: summary.gapCount,
        maxObjectSpan: summary.maxObjectSpan,
        mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
        coveragePath: current?.coverage_path ?? null,
        agpLayout,
      }),
    }));
    dispatchUi({ type: "setAssemblyBlocks", blocks: agpLayout.blocks });
    setStatusMessage(`AGP imported: ${file.name}`);
    dispatchUi({ type: "appendLog", message: `AGP imported: ${file.name}` });
  }

  async function importContactFile() {
    let selected: ImportedContactFile | null = null;
    try {
      selected = await invoke<ImportedContactFile | null>("select_contact_file");
    } catch (error) {
      setStatusMessage(`Contact map import failed: ${String(error)}`);
      dispatchUi({
        type: "appendLog",
        message: `Contact map import failed: ${String(error)}`,
      });
      return;
    }

    if (!selected) {
      setStatusMessage("Contact map import canceled");
      return;
    }

    setDataset((current) => ({
      ...buildDatasetSummary({
        agpPath: current?.agp_path ?? "",
        mcoolPath: selected.name,
        coolPath: selected.path,
        agpLines: current?.agp_lines ?? 0,
        agpObjects: current?.agp_objects ?? 0,
        agpComponents: current?.agp_components ?? 0,
        agpGaps: current?.agp_gaps ?? 0,
        maxObjectSpan: current?.max_object_span ?? 0,
        mcoolSizeBytes: selected.size_bytes,
        coveragePath: current?.coverage_path ?? null,
        agpLayout: current?.agp_layout ?? emptyAgpLayout(),
      }),
    }));
    setStatusMessage(`Contact map imported: ${selected.name}`);
    dispatchUi({ type: "appendLog", message: `Contact map imported: ${selected.name}` });
  }

  async function requestPafFile() {
    try {
      const selected = await invoke<ImportedContactFile | null>("select_paf_file");
      if (!selected) {
        setStatusMessage("PAF import canceled");
        return;
      }
      setPafPath(selected.path);
      setPafText("");
      setPafImported(true);
      setStatusMessage(`PAF imported: ${selected.name}`);
      dispatchUi({ type: "setOverviewMode", mode: "synteny" });
      dispatchUi({
        type: "appendLog",
        message: `PAF imported natively: ${selected.name} (${selected.size_bytes.toLocaleString()} bytes)`,
      });
    } catch {
      pafInputRef.current?.click();
    }
  }

  async function importPafFile(file: File) {
    const text = await file.text();
    const summary = summarizePafText(text);

    setPafPath(null);
    setPafText(text);
    setPafImported(true);
    setStatusMessage(
      `PAF imported: ${file.name} (${summary.alignmentCount.toLocaleString()} alignments)`,
    );
    dispatchUi({ type: "setOverviewMode", mode: "synteny" });
    dispatchUi({
      type: "appendLog",
      message: `PAF imported: ${file.name}; ${summary.alignmentCount.toLocaleString()} alignments, ${summary.ignoredLines.toLocaleString()} ignored`,
    });
  }

  async function requestCoverageFile() {
    try {
      const selected = await invoke<ImportedContactFile | null>("select_coverage_file");
      if (!selected) {
        setStatusMessage("Coverage import canceled");
        return;
      }

      setCoverageRecords([]);
      setDataset((current) => ({
        ...buildDatasetSummary({
          agpPath: current?.agp_path ?? "",
          mcoolPath: current?.mcool_path ?? "",
          coolPath: current?.cool_path ?? "",
          agpLines: current?.agp_lines ?? 0,
          agpObjects: current?.agp_objects ?? 0,
          agpComponents: current?.agp_components ?? 0,
          agpGaps: current?.agp_gaps ?? 0,
          maxObjectSpan: current?.max_object_span ?? 0,
          mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
          coveragePath: selected.path,
          agpLayout: current?.agp_layout ?? emptyAgpLayout(),
        }),
      }));
      setStatusMessage(`Coverage imported: ${selected.name}`);
      dispatchUi({
        type: "appendLog",
        message: `Coverage imported natively: ${selected.name} (${selected.size_bytes.toLocaleString()} bytes)`,
      });
    } catch {
      coverageInputRef.current?.click();
    }
  }

  async function importCoverageFile(file: File) {
    try {
      const records = parseBedGraphText(await file.text());
      setCoverageRecords(records);
      setDataset((current) => ({
        ...buildDatasetSummary({
          agpPath: current?.agp_path ?? "",
          mcoolPath: current?.mcool_path ?? "",
          coolPath: current?.cool_path ?? "",
          agpLines: current?.agp_lines ?? 0,
          agpObjects: current?.agp_objects ?? 0,
          agpComponents: current?.agp_components ?? 0,
          agpGaps: current?.agp_gaps ?? 0,
          maxObjectSpan: current?.max_object_span ?? 0,
          mcoolSizeBytes: current?.mcool_size_bytes ?? 0,
          coveragePath: file.name,
          agpLayout: current?.agp_layout ?? emptyAgpLayout(),
        }),
      }));
      setStatusMessage(`Coverage imported: ${file.name}`);
      dispatchUi({
        type: "appendLog",
        message: `Coverage imported: ${file.name} (${records.length.toLocaleString()} records)`,
      });
    } catch (error) {
      setStatusMessage(`Coverage import failed: ${String(error)}`);
      dispatchUi({ type: "appendLog", message: `Coverage import failed: ${String(error)}` });
    }
  }

  async function exportEditedAgp() {
    if (assemblyLayout.blocks.length === 0) {
      dispatchUi({ type: "appendLog", message: "No AGP layout to export" });
      return;
    }

    const agpText = exportAgpText(assemblyLayout.blocks);
    const filename = editedAgpFilename(dataset?.agp_path ?? "assembly.agp");
    try {
      const savedPath = await invoke<string | null>("save_agp_file", {
        defaultFilename: filename,
        contents: agpText,
      });

      if (!savedPath) {
        setStatusMessage("AGP export canceled");
        return;
      }

      setStatusMessage(`AGP exported: ${savedPath}`);
      dispatchUi({ type: "appendLog", message: `AGP exported: ${savedPath}` });
    } catch (error) {
      downloadTextFile(filename, agpText, "text/plain;charset=utf-8");
      setStatusMessage(`AGP exported: ${filename}`);
      dispatchUi({
        type: "appendLog",
        message: `AGP exported via browser download: ${filename}; native save failed: ${String(error)}`,
      });
    }
  }

  return (
    <AppShell
      dataset={dataset}
      contactMap={contactMap}
      overviewContactMap={overviewContactMap}
      syntenyView={syntenyView}
      coverageView={coverageView}
      pafText={pafText}
      pafImported={pafImported}
      onPafTextChange={(value) => {
        setPafPath(null);
        setPafText(value);
      }}
      agpInputRef={agpInputRef}
      pafInputRef={pafInputRef}
      coverageInputRef={coverageInputRef}
      onAgpFileSelected={importAgpFile}
      onContactFileSelected={importContactFile}
      onPafFileRequested={requestPafFile}
      onPafFileSelected={importPafFile}
      onCoverageFileRequested={requestCoverageFile}
      onCoverageFileSelected={importCoverageFile}
      onExportAgp={exportEditedAgp}
      onLoadExample={loadExamples}
      status={status}
      statusMessage={statusMessage}
      uiState={uiState}
      onUiAction={dispatchUi}
    />
  );
}

async function loadBrowserExampleSummary(): Promise<ExampleDatasetSummary> {
  const response = await fetch("/examples/groups.agp");
  if (!response.ok) {
    throw new Error(`Failed to load example AGP: ${response.status}`);
  }

  const text = await response.text();
  const summary = summarizeAgpText(text);

  return {
    ...buildDatasetSummary({
      agpPath: "examples/groups.agp",
      mcoolPath: "examples/input.q1.mcool",
      coolPath: "",
      agpLines: summary.lineCount,
      agpObjects: summary.objectCount,
      agpComponents: summary.componentCount,
      agpGaps: summary.gapCount,
      maxObjectSpan: summary.maxObjectSpan,
      mcoolSizeBytes: 26_324 * 1024,
      coveragePath: null,
      agpLayout: parseAgpLayout(text),
    }),
  };
}

interface DatasetSummaryInput {
  agpPath: string;
  mcoolPath: string;
  coolPath: string;
  agpLines: number;
  agpObjects: number;
  agpComponents: number;
  agpGaps: number;
  maxObjectSpan: number;
  mcoolSizeBytes: number;
  coveragePath: string | null;
  agpLayout: AgpLayout;
}

function buildDatasetSummary(input: DatasetSummaryInput): ExampleDatasetSummary {
  return {
    agp_path: input.agpPath,
    mcool_path: input.mcoolPath,
    cool_path: input.coolPath,
    agp_lines: input.agpLines,
    agp_objects: input.agpObjects,
    agp_components: input.agpComponents,
    agp_gaps: input.agpGaps,
    max_object_span: input.maxObjectSpan,
    mcool_size_bytes: input.mcoolSizeBytes,
    coverage_path: input.coveragePath,
    agp_layout: input.agpLayout,
  };
}

function ensureImportedDataset(summary: ExampleDatasetSummary): ExampleDatasetSummary {
  return buildDatasetSummary({
    agpPath: summary.agp_path,
    mcoolPath: summary.mcool_path,
    coolPath: summary.cool_path || summary.mcool_path,
    agpLines: summary.agp_lines,
    agpObjects: summary.agp_objects,
    agpComponents: summary.agp_components,
    agpGaps: summary.agp_gaps,
    maxObjectSpan: summary.max_object_span,
    mcoolSizeBytes: summary.mcool_size_bytes,
    coveragePath: summary.coverage_path,
    agpLayout: normalizeImportedAgpLayout(summary.agp_layout ?? emptyAgpLayout()),
  });
}

function emptyAgpLayout(): AgpLayout {
  return emptyLayout;
}

function editedAgpFilename(path: string) {
  const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.agp";
  return basename.replace(/(?:\.agp|\.txt)?$/i, ".edited.agp");
}

function overviewResolutionForSpan(totalSpanBp: number) {
  const targetBins = 320;
  const rawResolution = Math.max(1, Math.ceil(totalSpanBp / targetBins));
  const candidates = [5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
  return candidates.find((resolution) => resolution >= rawResolution) ?? candidates[candidates.length - 1];
}

function downloadTextFile(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function totalVisualSpan(blocks: AgpLayout["blocks"], fallback: number) {
  const finiteFallback = Number.isFinite(fallback) ? fallback : 0;
  const finiteBlockEnds = blocks
    .map((block) => block.visualEnd)
    .filter((visualEnd) => Number.isFinite(visualEnd));

  return Math.max(finiteFallback, 0, ...finiteBlockEnds);
}

function resolutionToBasePairs(resolution: ContactResolution) {
  return contactResolutionToBasePairs(resolution);
}

function formatViewportLabel(viewport: { xStart: number; xEnd: number }) {
  return `${Math.round(viewport.xStart / 1_000_000).toLocaleString()}-${Math.round(
    viewport.xEnd / 1_000_000,
  ).toLocaleString()} Mb`;
}

function hasContactMapData(contactMap: ContactMapView) {
  return contactMap.cells.length > 0
    || (contactMap.tiles?.length ?? 0) > 0
    || (contactMap.cachedTiles?.length ?? 0) > 0;
}

function trimContactTileCache(cache: Map<string, ContactMapTile>, protectedScope: string) {
  let cellCount = 0;
  for (const tile of cache.values()) {
    cellCount += tile.cells.length;
  }

  const protectedPrefix = `${protectedScope}:`;
  while (cache.size > maxFrontendContactTiles || cellCount > maxFrontendContactCells) {
    let evictionKey: string | undefined;
    for (const key of cache.keys()) {
      if (!key.startsWith(protectedPrefix)) {
        evictionKey = key;
        break;
      }
      if (evictionKey === undefined) {
        evictionKey = key;
      }
    }
    if (evictionKey === undefined) {
      break;
    }
    const evicted = cache.get(evictionKey);
    cache.delete(evictionKey);
    cellCount -= evicted?.cells.length ?? 0;
  }
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
}
