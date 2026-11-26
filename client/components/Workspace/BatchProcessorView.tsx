import React, { useState, useEffect, useRef } from "react";

interface FieldResult {
  value: string | null;
  confidencePercent: number | null;
}

interface ChequeResult {
  batchId: string;
  chequeId: string;
  fileName: string;
  pageNumber: number;
  status: string;
  accountNumber: FieldResult;
  accountHolderName: FieldResult;
  chequeDate: FieldResult;
  amountInWords: FieldResult;
  amountInFigures: FieldResult;
  needsReview: boolean;
  reviewReasons: string[];
  ocrDurationMs: number | null;
  errorMessage: string | null;
  imageUrl: string;
  fileUrl: string;
}

interface BatchStreamSummary {
  batchId?: string;
  status: string;
  totalFiles: number;
  totalCheques: number;
  processedCount: number;
  failedCount: number;
  processingTimeSeconds: number | null;
  throughputChequesPerSec: number | null;
  results: ChequeResult[];
}

interface Config {
  defaultWorkerThreads: number;
  maxWorkerThreads: number;
  maxCheques: number;
  acceptedExtensions: string[];
  ocrServiceUrl?: string;
}

export const BatchProcessorView: React.FC = () => {
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [folderPath, setFolderPath] = useState<string>("");
  const [ocrServiceUrl, setOcrServiceUrl] = useState<string>("https://9fba-2409-40e6-1d-fbff-48ba-84df-56b1-712a.ngrok-free.app");
  const [workerThreads, setWorkerThreads] = useState<number>(4);
  const [config, setConfig] = useState<Config>({
    defaultWorkerThreads: 4,
    maxWorkerThreads: 8,
    maxCheques: 250,
    acceptedExtensions: [".bmp", ".jpeg", ".jpg", ".pdf", ".png", ".tif", ".tiff"],
    ocrServiceUrl: "https://9fba-2409-40e6-1d-fbff-48ba-84df-56b1-712a.ngrok-free.app",
  });

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [doneCount, setDoneCount] = useState<number>(0);
  const [expectedCount, setExpectedCount] = useState<number>(0);

  const [summaryData, setSummaryData] = useState<BatchStreamSummary | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<any>(null);
  const startTimeRef = useRef<number>(0);

  // Fetch configuration limits on mount
  useEffect(() => {
    fetch("/api/cheques/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: Config | null) => {
        if (cfg) {
          setConfig(cfg);
          if (cfg.defaultWorkerThreads) setWorkerThreads(cfg.defaultWorkerThreads);
          if (cfg.ocrServiceUrl) setOcrServiceUrl(cfg.ocrServiceUrl);
        }
      })
      .catch(() => {});
  }, []);

  // Timer handler
  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startTimeRef.current) / 1000);
      }, 100);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  const addFiles = (files: File[]) => {
    const validFiles: File[] = [];
    const rejectedNames: string[] = [];

    files.forEach((f) => {
      const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
      if (config.acceptedExtensions.includes(ext)) {
        if (!pickedFiles.some((p) => p.name === f.name && p.size === f.size)) {
          validFiles.push(f);
        }
      } else {
        rejectedNames.push(f.name);
      }
    });

    if (rejectedNames.length > 0) {
      setErrorMsg(
        `Skipped ${rejectedNames.length} unsupported file(s): ${rejectedNames.slice(0, 3).join(", ")}. Accepted: ${config.acceptedExtensions.join(" ")}`
      );
    } else {
      setErrorMsg(null);
    }

    setPickedFiles((prev) => [...prev, ...validFiles]);
  };

  const removeFile = (index: number) => {
    setPickedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setPickedFiles([]);
  };

  const handleThreadsChange = (val: number) => {
    const clamped = Math.max(1, Math.min(val, config.maxWorkerThreads));
    setWorkerThreads(clamped);
  };

  /**
   * IMPORTANT FIX:
   *
   * ServiceNow Scripted REST resources automatically wrap every
   * response.setBody(x) call as:
   *
   *   { "result": x }
   *
   * The previous version of this function returned that raw, still-wrapped
   * body. Every caller (startProcessing, pollBatch/makeSummaryFromStatus)
   * expects a FLAT object — e.g. accepted.batchId, data.status,
   * data.totalCheques, data.results — so every one of those reads was
   * silently coming back `undefined`.
   *
   * That's why the batch status always looked like "still 0 of 0
   * processing" even though the backend logs proved the OCR call
   * completed successfully in ~1.3s: makeSummaryFromStatus() was
   * defaulting totalCheques to 0 and status to "PROCESSING" forever,
   * so the poll loop's completion check could never become true.
   *
   * Fix: unwrap the `result` envelope once, right here, so every caller
   * downstream can keep treating the response as flat (which they already
   * do, and don't need to change).
   */
  const serviceNowRequest = async (
    payload: Record<string, unknown>,
  ): Promise<any> => {
    const res = await fetch(
      "/api/x_2210302_gear_up/cheque_ocr/cheques/process",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-UserToken": (window as any).g_ck || "",
        },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      },
    );

    const text = await res.text();

    let rawBody: any = null;

    if (text) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new Error(
          `ServiceNow returned non-JSON response (HTTP ${res.status}).`,
        );
      }
    }

    // Unwrap ServiceNow's { result: {...} } envelope if present.
    const body =
      rawBody && typeof rawBody === "object" && "result" in rawBody
        ? (rawBody as any).result
        : rawBody;

    console.log("[OCR] ServiceNow response (unwrapped):", body);

    if (!res.ok) {
      const message =
        body?.error?.message ||
        body?.error ||
        body?.message ||
        `HTTP ${res.status} ${res.statusText}`;

      throw new Error(String(message));
    }

    return body || {};
  };

  const makeSummaryFromStatus = (
    data: any,
    fallbackBatchId: string,
  ): BatchStreamSummary => {
    const results: ChequeResult[] = Array.isArray(data?.results)
      ? data.results
      : [];

    const processedCount =
      Number.isFinite(Number(data?.processedCount))
        ? Number(data.processedCount)
        : results.filter(
            (r) => r?.status === "PROCESSED",
          ).length;

    const failedCount =
      Number.isFinite(Number(data?.failedCount))
        ? Number(data.failedCount)
        : results.filter(
            (r) => r?.status === "OCR_FAILED",
          ).length;

    return {
      batchId:
        data?.batchId ||
        fallbackBatchId,

      status:
        data?.status ||
        "PROCESSING",

      totalFiles:
        Number(data?.totalFiles) ||
        results.length,

      totalCheques:
        Number(data?.totalCheques) ||
        results.length,

      processedCount,
      failedCount,

      processingTimeSeconds:
        data?.processingTimeSeconds == null
          ? null
          : Number(
              data.processingTimeSeconds,
            ),

      throughputChequesPerSec:
        data?.throughputChequesPerSec == null
          ? null
          : Number(
              data.throughputChequesPerSec,
            ),

      results,
    };
  };

  const pollBatch = async (
    batchId: string,
  ): Promise<void> => {
    const maxAttempts = 300;

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt++
    ) {
      const data =
        await serviceNowRequest({
          action: "status",
          batch_id: batchId,
        });

      // Visibility: confirms the status poll is actually firing and
      // shows exactly what came back, unwrapped.
      console.log(
        `[OCR] Poll #${attempt + 1} for ${batchId}:`,
        data,
      );

      const summary =
        makeSummaryFromStatus(
          data,
          batchId,
        );

      setSummaryData(summary);

      setExpectedCount(
        summary.totalCheques,
      );

      setDoneCount(
        summary.processedCount +
          summary.failedCount,
      );

      if (
        summary.status === "COMPLETED" ||
        (
          summary.totalCheques > 0 &&
          summary.processedCount +
            summary.failedCount >=
            summary.totalCheques
        )
      ) {
        setIsRunning(false);
        return;
      }

      await new Promise<void>(
        (resolve) => {
          window.setTimeout(
            resolve,
            2000,
          );
        },
      );
    }

    setIsRunning(false);

    throw new Error(
      "Batch is still processing on ServiceNow. The browser stopped polling after 10 minutes.",
    );
  };

  const startProcessing = async () => {
    if (
      pickedFiles.length === 0 &&
      !folderPath.trim()
    ) {
      return;
    }

    /*
     * A browser cannot read an arbitrary server filesystem path.
     * The ServiceNow implementation receives browser files as Base64.
     */
    if (
      pickedFiles.length === 0 &&
      folderPath.trim()
    ) {
      setErrorMsg(
        "Server-folder processing is not available from the browser. Please select the cheque files from your computer.",
      );
      return;
    }

    if (
      config.maxCheques > 0 &&
      pickedFiles.length >
        config.maxCheques
    ) {
      setErrorMsg(
        `You selected ${pickedFiles.length} files. The maximum is ${config.maxCheques}.`,
      );
      return;
    }

    setIsRunning(true);
    setErrorMsg(null);
    setElapsed(0);
    setDoneCount(0);
    setExpectedCount(
      pickedFiles.length,
    );

    const initialSummary: BatchStreamSummary =
      {
        status: "PROCESSING",
        totalFiles:
          pickedFiles.length,
        totalCheques:
          pickedFiles.length,
        processedCount: 0,
        failedCount: 0,
        processingTimeSeconds: null,
        throughputChequesPerSec:
          null,
        results: [],
      };

    setSummaryData(
      initialSummary,
    );

    try {
      const batchId =
        `BATCH-${Date.now()}`;

      const cheques =
        await Promise.all(
          pickedFiles.map(
            async (
              file,
              index,
            ) => {
              const buffer =
                await file.arrayBuffer();

              const bytes =
                new Uint8Array(
                  buffer,
                );

              let binary = "";

              const chunkSize =
                0x8000;

              for (
                let offset = 0;
                offset <
                bytes.length;
                offset +=
                  chunkSize
              ) {
                const chunk =
                  bytes.subarray(
                    offset,
                    Math.min(
                      offset +
                        chunkSize,
                      bytes.length,
                    ),
                  );

                binary +=
                  String.fromCharCode(
                    ...chunk,
                  );
              }

              const base64 =
                btoa(binary);

              if (!base64) {
                throw new Error(
                  `Base64 conversion produced empty data for ${file.name}`,
                );
              }

              return {
                cheque_id:
                  `${batchId}-CHEQUE-${index + 1}`,

                source_file_name:
                  file.name,

                content_type:
                  file.type ||
                  "application/octet-stream",

                page_number: 1,

                file_content_base64:
                  base64,
              };
            },
          ),
        );

      const payload = {
        batch_id: batchId,
        cheques,
        worker_threads:
          workerThreads,

        folder_path:
          folderPath.trim() ||
          null,

        ocr_service_url:
          ocrServiceUrl.trim() ||
          null,
      };

      console.log(
        "[OCR] Sending JSON request to ServiceNow",
      );

      console.log(
        "[OCR] Batch ID:",
        batchId,
      );

      console.log(
        "[OCR] Files:",
        cheques.map(
          (c) =>
            c.source_file_name,
        ),
      );

      console.log(
        "[OCR] OCR Service:",
        ocrServiceUrl,
      );

      console.log(
        "[OCR] Worker threads:",
        workerThreads,
      );

      console.log(
        "[OCR] Base64 lengths:",
        cheques.map(
          (c) =>
            `${c.source_file_name}: ${c.file_content_base64.length}`,
        ),
      );

      /*
       * ServiceNow returns normal JSON here. It does NOT return an NDJSON
       * stream. After accepting the batch, poll the SAME POST /process
       * resource using action=status.
       *
       * serviceNowRequest() now returns the UNWRAPPED body (see fix above),
       * so `accepted.batchId` / `accepted.totalCheques` etc. below are the
       * real values, not undefined.
       */
      const accepted =
        await serviceNowRequest(
          payload,
        );

      console.log(
        "[OCR] ServiceNow accepted batch:",
        accepted,
      );

      const acceptedBatchId =
        String(
          accepted?.batchId ||
          accepted?.batch_id ||
          batchId,
        );

      const acceptedTotal =
        Number(
          accepted?.totalCheques,
        ) ||
        pickedFiles.length;

      setSummaryData({
        ...initialSummary,
        batchId:
          acceptedBatchId,
        totalFiles:
          Number(
            accepted?.totalFiles,
          ) ||
          pickedFiles.length,
        totalCheques:
          acceptedTotal,
      });

      setExpectedCount(
        acceptedTotal,
      );

      await pollBatch(
        acceptedBatchId,
      );

    } catch (err: any) {
      console.error(
        "[OCR] Processing failed:",
        err,
      );

      setErrorMsg(
        err?.message ||
        "Failed to process batch",
      );

      setIsRunning(false);
    } finally {
      setPickedFiles([]);
    }
  };

  const renderConfidence = (field: FieldResult) => {
    const pct = field?.confidencePercent;
    if (pct == null) return <span className="conf-badge low">—</span>;
    if (pct >= 80) return <span className="conf-badge high">{pct.toFixed(1)}%</span>;
    if (pct >= 50) return <span className="conf-badge mid">{pct.toFixed(1)}%</span>;
    return <span className="conf-badge low">{pct.toFixed(1)}%</span>;
  };

  const downloadCsv = () => {
    if (!summaryData) return;
    const headers = [
      "File name",
      "Cheque ID",
      "Account number",
      "Account number confidence %",
      "Account holder name",
      "Account holder name confidence %",
      "Time taken (s)",
      "Status",
      "Needs review",
      "Error message",
    ];

    const rows = summaryData.results.map((r) => [
      r.fileName,
      r.chequeId,
      r.accountNumber?.value || "",
      r.accountNumber?.confidencePercent ?? "",
      r.accountHolderName?.value || "",
      r.accountHolderName?.confidencePercent ?? "",
      r.ocrDurationMs ? (r.ocrDurationMs / 1000).toFixed(2) : "",
      r.status,
      r.needsReview ? "Yes" : "No",
      r.errorMessage || "",
    ]);

    const csvContent = "\uFEFF" + [headers, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    saveFile(csvContent, `cheques_export_${Date.now()}.csv`, "text/csv;charset=utf-8");
  };

  const downloadJson = () => {
    if (!summaryData) return;
    saveFile(JSON.stringify(summaryData, null, 2), `cheques_batch_${summaryData.batchId || "export"}.json`, "application/json");
  };

  const saveFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyJson = () => {
    if (!summaryData) return;
    navigator.clipboard.writeText(JSON.stringify(summaryData, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="batch-processor-container">
      {/* Header */}
      <div className="bp-header">
        <h2>Cheque OCR Batch Processor & Realtime Stream</h2>
        <p className="bp-sub">
          Upload multiple cheque files or specify a server folder. Files are automatically organized into batch folders and processed live via PaddleOCR.
        </p>
      </div>

      {/* Error Alert */}
      {errorMsg && <div className="bp-error">{errorMsg}</div>}

      {/* Main Panel */}
      <div className="bp-panel">
        {/* Dropzone */}
        <div
          className="bp-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleFileDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="bp-drop-icon">📁</div>
          <div className="bp-drop-big">Drop cheque files here, or click to browse</div>
          <div className="bp-drop-small">
            Multiple files at once · {config.acceptedExtensions.join(" ")} · up to {config.maxCheques} cheques
          </div>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            multiple
            accept={config.acceptedExtensions.join(",")}
            onChange={handleFilePick}
          />
        </div>

        {/* Divider */}
        <div className="bp-divider">
          <span>OR A FOLDER ON THE SERVER MACHINE</span>
        </div>

        {/* Server Folder Input */}
        <div className="bp-folder-row">
          <input
            type="text"
            className="bp-input"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="e.g. /home/atomic-shadow/development/cts-cheque-ocr-sdk/storage/BATCH-001"
          />
          <div className="bp-folder-note">
            Reads all cheque files inside the specified server directory. Files will be indexed into a new batch automatically.
          </div>
        </div>

        {/* Selected Files List */}
        {pickedFiles.length > 0 && (
          <div className="bp-files-box">
            <div className="bp-files-head">
              <span>{pickedFiles.length} file(s) selected</span>
              <button className="bp-btn-text" onClick={clearFiles}>
                Clear all
              </button>
            </div>
            <div className="bp-chips">
              {pickedFiles.map((f, idx) => (
                <span className="bp-chip" key={idx}>
                  <span className="bp-chip-name">{f.name}</span>
                  <button className="bp-chip-remove" onClick={() => removeFile(idx)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Active OCR Engine Indicator */}
        <div className="bp-folder-row" style={{ marginTop: "14px" }}>
          <div style={{ fontSize: "12.5px", color: "#475569" }}>
            <span style={{ fontWeight: 600 }}>Active OCR Engine:</span>{" "}
            <code style={{ background: "#eef2f6", padding: "2px 8px", borderRadius: "4px", color: "#1f5fd0", fontWeight: 700 }}>
              {ocrServiceUrl || "http://localhost:8000"}
            </code>{" "}
            <span style={{ fontSize: "11.5px", color: "#64748b" }}>(automatically loaded from server .env)</span>
          </div>
        </div>

        {/* Parallelism Control */}
        <div className="bp-parallel-box">
          <span className="bp-label">Parallel OCR Threads:</span>
          <input
            type="number"
            className="bp-num-input"
            min={1}
            max={config.maxWorkerThreads}
            value={workerThreads}
            onChange={(e) => handleThreadsChange(parseInt(e.target.value, 10) || 1)}
          />
          <input
            type="range"
            className="bp-range-input"
            min={1}
            max={config.maxWorkerThreads}
            value={workerThreads}
            onChange={(e) => handleThreadsChange(parseInt(e.target.value, 10) || 1)}
          />
          <span className="bp-threads-note">
            {workerThreads} cheque(s) processed simultaneously (max {config.maxWorkerThreads}).
          </span>
        </div>

        {/* Actions & Progress */}
        <div className="bp-actions">
          <button
            className="bp-btn-primary"
            disabled={isRunning || (pickedFiles.length === 0 && !folderPath.trim())}
            onClick={startProcessing}
          >
            {isRunning ? "Processing..." : "Process Cheques"}
          </button>

          {isRunning && (
            <div className="bp-running-box">
              <div className="bp-spinner"></div>
              <div className="bp-run-info">
                <div className="bp-run-text">
                  <b>{doneCount}</b> of <b>{expectedCount}</b> done — elapsed <b>{elapsed.toFixed(1)}s</b>
                </div>
                <div className="bp-bar-track">
                  <div
                    className="bp-bar-fill"
                    style={{ width: `${expectedCount > 0 ? (doneCount / expectedCount) * 100 : 0}%` }}
                  ></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      {summaryData && (
        <div className="bp-panel bp-summary-panel">
          <div className="bp-stats-grid">
            <div className="bp-stat-card">
              <div className="bp-stat-k">Total Cheques</div>
              <div className="bp-stat-v">{summaryData.totalCheques}</div>
            </div>
            <div className="bp-stat-card">
              <div className="bp-stat-k">Processed</div>
              <div className="bp-stat-v bp-good">{summaryData.processedCount}</div>
            </div>
            <div className="bp-stat-card">
              <div className="bp-stat-k">Failed</div>
              <div className={`bp-stat-v ${summaryData.failedCount > 0 ? "bp-fail" : ""}`}>{summaryData.failedCount}</div>
            </div>
            <div className="bp-stat-card">
              <div className="bp-stat-k">Total Time</div>
              <div className="bp-stat-v">{summaryData.processingTimeSeconds != null ? `${summaryData.processingTimeSeconds}s` : "—"}</div>
            </div>
            <div className="bp-stat-card">
              <div className="bp-stat-k">Throughput</div>
              <div className="bp-stat-v">{summaryData.throughputChequesPerSec != null ? `${summaryData.throughputChequesPerSec} /s` : "—"}</div>
            </div>
          </div>
        </div>
      )}

      {/* Results Table */}
      {summaryData && (
        <div className="bp-panel bp-table-panel">
          <div className="bp-results-bar">
            <div className="bp-results-title">
              Live Results {summaryData.batchId ? `(${summaryData.batchId})` : ""}
            </div>
            <div className="bp-dl-group">
              <button className="bp-btn-secondary" onClick={() => setIsModalOpen(true)}>
                View JSON
              </button>
              <button className="bp-btn-secondary" onClick={downloadCsv}>
                Download CSV
              </button>
              <button className="bp-btn-secondary" onClick={downloadJson}>
                Download JSON
              </button>
            </div>
          </div>

          <div className="bp-table-wrap">
            <table className="bp-table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th>Account Number</th>
                  <th style={{ textAlign: "right" }}>Confidence</th>
                  <th>Account Holder Name</th>
                  <th style={{ textAlign: "right" }}>Confidence</th>
                  <th style={{ textAlign: "right" }}>Time Taken</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {summaryData.results.map((r, idx) => (
                  <tr key={idx} className="bp-tr">
                    <td className="bp-td-bold">{r.fileName}</td>
                    <td className="bp-td-mono">{r.accountNumber?.value || <span className="bp-none">not found</span>}</td>
                    <td style={{ textAlign: "right" }}>{renderConfidence(r.accountNumber)}</td>
                    <td>{r.accountHolderName?.value || <span className="bp-none">not found</span>}</td>
                    <td style={{ textAlign: "right" }}>{renderConfidence(r.accountHolderName)}</td>
                    <td style={{ textAlign: "right" }}>{r.ocrDurationMs ? `${(r.ocrDurationMs / 1000).toFixed(2)}s` : "—"}</td>
                    <td>
                      <span className={`bp-badge ${r.status === "PROCESSED" ? "bp-badge-ok" : "bp-badge-fail"}`}>
                        {r.status === "PROCESSED" ? "Processed" : "Failed"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* JSON Modal */}
      {isModalOpen && summaryData && (
        <div className="bp-modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div className="bp-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="bp-modal-head">
              <h3>Batch JSON ({summaryData.batchId || "Live Data"})</h3>
              <div className="bp-modal-acts">
                {copied && <span className="bp-copied-text">Copied!</span>}
                <button className="bp-btn-secondary" onClick={copyJson}>
                  Copy
                </button>
                <button className="bp-btn-secondary" onClick={downloadJson}>
                  Download
                </button>
                <button className="bp-btn-secondary" onClick={() => setIsModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="bp-modal-body">
              <pre>{JSON.stringify(summaryData, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};