import type {
  BatchDetail,
  BatchSummary,
  ChequeDetail,
  UiConfig,
} from "./types";

const BASE =
  "/api/x_2210302_gear_up/cheque_ocr/cheques";

const OCR_SERVICE_URL =
  "https://9fba-2409-40e6-1d-fbff-48ba-84df-56b1-712a.ngrok-free.app";

/*
 * Polling configuration
 */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function getCsrfToken(): string {
  return (window as any).g_ck || "";
}

/**
 * Extract useful error information from a response.
 */
async function errorMessage(
  res: Response,
): Promise<string> {
  try {
    const body = await res.json();

    const data =
      body &&
      typeof body === "object" &&
      body.result &&
      typeof body.result === "object"
        ? body.result
        : body;

    if (
      data &&
      typeof data.error === "string"
    ) {
      return data.error;
    }

    if (
      data &&
      typeof data.message === "string"
    ) {
      return data.message;
    }

    if (
      data &&
      typeof data.detail === "string"
    ) {
      return data.detail;
    }
  } catch {
    // Ignore non-JSON response.
  }

  return `${res.status} ${res.statusText}`;
}

/**
 * ServiceNow often returns:
 *
 * {
 *   result: {...}
 * }
 *
 * This unwraps it.
 */
function unwrapServiceNowResult<T>(
  body: unknown,
): T {
  if (
    body &&
    typeof body === "object" &&
    Object.prototype.hasOwnProperty.call(
      body,
      "result",
    )
  ) {
    return (
      body as {
        result: T;
      }
    ).result;
  }

  return body as T;
}

/**
 * Generic ServiceNow request.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${BASE}${path}`;

  console.log(
    "[API] Request:",
    init?.method || "GET",
    url,
  );

  const res = await fetch(url, {
    ...init,

    headers: {
      "X-UserToken": getCsrfToken(),

      Accept:
        "application/json",

      ...(init?.headers ?? {}),
    },
  });

  console.log(
    "[API] Response:",
    res.status,
    res.statusText,
    url,
  );

  if (!res.ok) {
    const message =
      await errorMessage(res);

    console.error(
      "[API] Request failed:",
      res.status,
      message,
      url,
    );

    throw new ApiError(
      message,
      res.status,
    );
  }

  const body =
    await res.json();

  console.log(
    "[API] Raw response:",
    body,
  );

  const unwrapped =
    unwrapServiceNowResult<T>(body);

  console.log(
    "[API] Unwrapped response:",
    unwrapped,
  );

  return unwrapped;
}

/**
 * Convert File -> Base64.
 */
async function fileToBase64(
  file: File,
): Promise<string> {
  const arrayBuffer =
    await file.arrayBuffer();

  const bytes =
    new Uint8Array(arrayBuffer);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    const chunk =
      bytes.subarray(
        offset,
        Math.min(
          offset + chunkSize,
          bytes.length,
        ),
      );

    binary += String.fromCharCode(
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

  return base64;
}

/**
 * GET configuration.
 */
export const getConfig =
  () =>
    request<UiConfig>(
      "/config",
    );

/**
 * GET all batches.
 */
export const listBatches =
  () =>
    request<BatchSummary[]>(
      "/batches",
    );

/**
 * GET one batch.
 */
export const getBatch =
  (
    batchId: string,
  ) =>
    request<BatchDetail>(
      `/batches/${encodeURIComponent(
        batchId,
      )}`,
    );

/**
 * GET one cheque.
 */
export const getCheque =
  (
    batchId: string,
    chequeId: string,
  ) =>
    request<ChequeDetail>(
      `/batches/${encodeURIComponent(
        batchId,
      )}/cheques/${encodeURIComponent(
        chequeId,
      )}`,
    );

/**
 * Verify cheque account number.
 */
export const verifyCheque =
  (
    batchId: string,
    chequeId: string,
    verifiedAccountNumber: string,
  ) =>
    request<ChequeDetail>(
      `/batches/${encodeURIComponent(
        batchId,
      )}/cheques/${encodeURIComponent(
        chequeId,
      )}`,
      {
        method: "PATCH",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body: JSON.stringify({
          verifiedAccountNumber,
        }),
      },
    );

/**
 * Sleep helper.
 */
function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds,
      ),
  );
}

/**
 * Extract status from different possible
 * BatchDetail response shapes.
 */
function getBatchStatus(
  batch: any,
): string {
  if (!batch) {
    return "";
  }

  return String(
    batch.status ??
    batch.state ??
    batch.result?.status ??
    "",
  ).toUpperCase();
}

/**
 * Extract processed count.
 */
function getProcessedCount(
  batch: any,
): number {
  if (!batch) {
    return 0;
  }

  const value =
    batch.processed ??
    batch.processedCheques ??
    batch.completed ??
    batch.completedCheques ??
    batch.result?.processed ??
    batch.result?.processedCheques ??
    0;

  const numberValue =
    Number(value);

  return Number.isFinite(
    numberValue,
  )
    ? numberValue
    : 0;
}

/**
 * Extract total cheque count.
 */
function getTotalCount(
  batch: any,
): number {
  if (!batch) {
    return 0;
  }

  const value =
    batch.totalCheques ??
    batch.total ??
    batch.chequeCount ??
    batch.result?.totalCheques ??
    0;

  const numberValue =
    Number(value);

  return Number.isFinite(
    numberValue,
  )
    ? numberValue
    : 0;
}

/**
 * Wait until ServiceNow finishes the batch.
 *
 * IMPORTANT:
 *
 * This is the part that was missing from
 * the current flow.
 *
 * POST /process only means:
 *
 * "ServiceNow accepted the batch."
 *
 * It does NOT mean:
 *
 * "OCR is finished."
 *
 * Therefore we explicitly call:
 *
 * GET /batches/{batchId}
 *
 * until the worker finishes.
 */
async function waitForBatchCompletion(
  batchId: string,
): Promise<BatchDetail> {
  const startedAt =
    Date.now();

  let attempt = 0;

  console.log(
    "[OCR] ========================================",
  );

  console.log(
    "[OCR] Starting batch polling",
  );

  console.log(
    "[OCR] Batch ID:",
    batchId,
  );

  console.log(
    "[OCR] Poll endpoint:",
    `${BASE}/batches/${batchId}`,
  );

  console.log(
    "[OCR] ========================================",
  );

  while (true) {
    attempt++;

    const elapsed =
      Date.now() - startedAt;

    /*
     * HARD TIMEOUT
     *
     * This prevents the browser from
     * spinning forever.
     */
    if (
      elapsed >=
      MAX_POLL_TIME_MS
    ) {
      console.error(
        "[OCR] Batch polling timed out:",
        batchId,
      );

      throw new Error(
        `Batch ${batchId} did not finish within 5 minutes.`,
      );
    }

    console.log(
      `[OCR] Poll #${attempt} → GET batch status`,
      {
        batchId,
        elapsedSeconds:
          Math.round(
            elapsed / 1000,
          ),
      },
    );

    let batch: BatchDetail;

    try {
      batch =
        await getBatch(
          batchId,
        );
    } catch (error) {
      console.error(
        `[OCR] Poll #${attempt} failed:`,
        error,
      );

      /*
       * Do not immediately kill the entire
       * batch for one temporary GET failure.
       *
       * Try again.
       */
      await sleep(
        POLL_INTERVAL_MS,
      );

      continue;
    }

    const status =
      getBatchStatus(
        batch,
      );

    const processed =
      getProcessedCount(
        batch,
      );

    const total =
      getTotalCount(
        batch,
      );

    console.log(
      `[OCR] Poll #${attempt} result:`,
      {
        status,
        processed,
        total,
        batch,
      },
    );

    /*
     * TERMINAL SUCCESS
     */
    if (
      status === "COMPLETED" ||
      status === "COMPLETE" ||
      status === "DONE" ||
      status === "SUCCESS"
    ) {
      console.log(
        "[OCR] ========================================",
      );

      console.log(
        "[OCR] BATCH COMPLETED",
      );

      console.log(
        "[OCR] Batch ID:",
        batchId,
      );

      console.log(
        "[OCR] Processed:",
        processed,
      );

      console.log(
        "[OCR] Total:",
        total,
      );

      console.log(
        "[OCR] ========================================",
      );

      return batch;
    }

    /*
     * TERMINAL FAILURE
     */
    if (
      status === "FAILED" ||
      status === "ERROR" ||
      status === "CANCELLED" ||
      status === "CANCELED"
    ) {
      console.error(
        "[OCR] ========================================",
      );

      console.error(
        "[OCR] BATCH FAILED",
      );

      console.error(
        "[OCR] Batch ID:",
        batchId,
      );

      console.error(
        "[OCR] Response:",
        batch,
      );

      console.error(
        "[OCR] ========================================",
      );

      const error =
        (batch as any)?.error ??
        (batch as any)?.message ??
        "Batch processing failed.";

      throw new Error(
        String(error),
      );
    }

    /*
     * Still processing.
     */
    console.log(
      `[OCR] Batch still processing: ${status || "UNKNOWN"}`,
    );

    await sleep(
      POLL_INTERVAL_MS,
    );
  }
}

/**
 * Process uploaded cheque files.
 *
 * Flow:
 *
 * Browser
 *   ↓
 * Base64
 *   ↓
 * POST /process
 *   ↓
 * ServiceNow accepts batch
 *   ↓
 * GET /batches/{batchId}  ← IMPORTANT
 *   ↓
 * poll until COMPLETED
 *   ↓
 * return completed batch
 */
export const processBatch =
  async (
    files: File[],
    workerThreads?: number,
  ) => {
    if (
      !files ||
      files.length === 0
    ) {
      throw new Error(
        "Please select at least one file.",
      );
    }

    const batchId =
      `BATCH-${Date.now()}`;

    console.log(
      "[OCR] ========================================",
    );

    console.log(
      "[OCR] Preparing batch",
    );

    console.log(
      "[OCR] Batch ID:",
      batchId,
    );

    console.log(
      "[OCR] Files:",
      files.map(
        (file) =>
          file.name,
      ),
    );

    console.log(
      "[OCR] ========================================",
    );

    const cheques: Array<{
      cheque_id: string;
      source_file_name: string;
      content_type: string;
      page_number: number;
      file_content_base64: string;
    }> = [];

    for (
      let index = 0;
      index < files.length;
      index++
    ) {
      const file =
        files[index];

      if (!file) {
        continue;
      }

      const base64 =
        await fileToBase64(
          file,
        );

      console.log(
        "[OCR] Base64 prepared:",
        {
          file: file.name,
          bytes: file.size,
          base64Chars:
            base64.length,
        },
      );

      cheques.push({
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
      });
    }

    if (
      cheques.length === 0
    ) {
      throw new Error(
        "No valid files were prepared.",
      );
    }

    const threads =
      workerThreads || 4;

    const body = {
      batch_id:
        batchId,

      cheques,

      worker_threads:
        threads,

      ocr_service_url:
        OCR_SERVICE_URL,
    };

    console.log(
      "[OCR] Sending JSON request to ServiceNow",
    );

    console.log(
      "[OCR] POST:",
      `${BASE}/process`,
    );

    console.log(
      "[OCR] Payload:",
      {
        batch_id:
          batchId,

        cheque_count:
          cheques.length,

        worker_threads:
          threads,

        ocr_service_url:
          OCR_SERVICE_URL,
      },
    );

    console.log(
      "[OCR] Base64 lengths:",
      cheques.map(
        (cheque) =>
          `${cheque.source_file_name}: ${cheque.file_content_base64.length}`,
      ),
    );

    /*
     * STEP 1
     *
     * Submit batch.
     */
    const accepted =
      await request<any>(
        "/process",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json",
          },

          body:
            JSON.stringify(
              body,
            ),
        },
      );

    console.log(
      "[OCR] ServiceNow raw accepted response:",
      accepted,
    );

    /*
     * Handle both possible response shapes:
     *
     * {
     *   success: true,
     *   batchId: "..."
     * }
     *
     * OR
     *
     * {
     *   result: {
     *      success: true,
     *      batchId: "..."
     *   }
     * }
     */
    const acceptedResult =
      accepted?.result &&
      typeof accepted.result === "object"
        ? accepted.result
        : accepted;

    console.log(
      "[OCR] Normalized accepted response:",
      acceptedResult,
    );

    if (
      !acceptedResult ||
      acceptedResult.success !== true
    ) {
      throw new Error(
        acceptedResult?.error ||
        acceptedResult?.message ||
        "ServiceNow failed to accept the batch.",
      );
    }

    const returnedBatchId =
      acceptedResult.batchId ||
      acceptedResult.batch_id ||
      batchId;

    if (
      !returnedBatchId
    ) {
      throw new Error(
        "ServiceNow accepted the batch but did not return a batch ID.",
      );
    }

    console.log(
      "[OCR] ServiceNow accepted batch:",
      {
        batchId:
          returnedBatchId,

        status:
          acceptedResult.status,

        totalCheques:
          acceptedResult.totalCheques,
      },
    );

    /*
     * STEP 2
     *
     * DO NOT RETURN HERE.
     *
     * This was effectively where the old
     * flow stopped.
     *
     * Start polling immediately.
     */
    console.log(
      "[OCR] Starting GET batch polling now...",
    );

    const completedBatch =
      await waitForBatchCompletion(
        returnedBatchId,
      );

    /*
     * STEP 3
     *
     * Return the completed batch to the
     * React/UI layer.
     */
    console.log(
      "[OCR] Final completed batch:",
      completedBatch,
    );

    return completedBatch;
  };