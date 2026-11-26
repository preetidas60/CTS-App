/**
 * chequeProcessingService.js
 * ---------------------------
 * ServiceNow-side cheque batch processing service.
 *
 * IMPORTANT:
 * This version is designed for the current Gear Up application.
 *
 * Expected request body:
 *
 * {
 *   "batch_id": "BATCH-123",
 *   "cheques": [
 *     {
 *       "cheque_id": "BATCH-123-CHEQUE-1",
 *       "source_file_name": "specimen_cheque_01.pdf",
 *       "page_number": 1,
 *       "file_content_base64": "JVBERi0x..."
 *     }
 *   ],
 *   "worker_threads": 4,
 *   "folder_path": null,
 *   "ocr_service_url": "https://9094-2409-40e6-3f-c8d8-6c3e-3209-9e61-fc17.ngrok-free.app"
 * }
 *
 * The browser sends JSON + Base64.
 * ServiceNow stores the Base64 content as an attachment.
 * The attachment is later consumed by ocrServiceClient.js.
 */

import {
  GlideRecord,
  GlideDateTime,
  GlideSysAttachment
} from "@servicenow/glide";


// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

var ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".bmp"
];

var BATCH_TABLE = "x_2210302_gear_up_batch";
var RECORD_TABLE = "x_2210302_gear_up_record";


// -----------------------------------------------------------------------------
// Configuration helpers
// -----------------------------------------------------------------------------

function maxCheques() {
  var value = parseInt(
    gs.getProperty(
      "x_2210302_gear_up.ocr.batch.max_cheques",
      "250"
    ),
    10
  );

  return isNaN(value) ? 250 : value;
}


function defaultWorkerThreads() {
  var value = parseInt(
    gs.getProperty(
      "x_2210302_gear_up.ocr.worker.pool_size",
      "4"
    ),
    10
  );

  return isNaN(value) || value < 1 ? 4 : value;
}


function maxWorkerThreads() {
  var value = parseInt(
    gs.getProperty(
      "x_2210302_gear_up.ocr.worker.max_pool_size",
      "8"
    ),
    10
  );

  return isNaN(value) || value < 1 ? 8 : value;
}


function unlimited() {
  return maxCheques() <= 0;
}


// -----------------------------------------------------------------------------
// File helpers
// -----------------------------------------------------------------------------

function extensionOf(fileName) {

  fileName = String(fileName || "");

  var dot = fileName.lastIndexOf(".");

  if (dot <= 0) {
    return "";
  }

  return fileName.substring(dot).toLowerCase();
}


function baseName(fileName) {

  fileName = String(fileName || "cheque");

  var name = fileName.replace(/^.*[\\/]/, "");

  var ext = extensionOf(name);

  if (ext && name.length > ext.length) {
    name = name.substring(
      0,
      name.length - ext.length
    );
  }

  var cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "");

  return cleaned || "cheque";
}


function uniqueId(base, used) {

  var candidate = base;

  var suffix = 2;

  while (used[candidate]) {
    candidate = base + "_" + suffix;
    suffix++;
  }

  used[candidate] = true;

  return candidate;
}


function contentTypeForExtension(ext) {

  switch (String(ext || "").toLowerCase()) {

    case ".pdf":
      return "application/pdf";

    case ".png":
      return "image/png";

    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".tif":
    case ".tiff":
      return "image/tiff";

    case ".bmp":
      return "image/bmp";

    default:
      return "application/octet-stream";
  }
}


// -----------------------------------------------------------------------------
// Configuration endpoint
// -----------------------------------------------------------------------------

function getConfig(request, response) {

  response.setStatus(200);

  response.setBody({
    defaultWorkerThreads: defaultWorkerThreads(),
    maxWorkerThreads: maxWorkerThreads(),
    maxCheques: maxCheques(),
    acceptedExtensions: ACCEPTED_EXTENSIONS.slice().sort()
  });
}


// -----------------------------------------------------------------------------
// Batch ID
// -----------------------------------------------------------------------------

function nextBatchSequence() {

  var aggregate = new GlideRecord(BATCH_TABLE);

  aggregate.addAggregate("COUNT");

  aggregate.query();

  var count = 0;

  if (aggregate.next()) {
    count =
      parseInt(
        aggregate.getAggregate("COUNT"),
        10
      ) || 0;
  }

  return count + 1;
}


function generateBatchId(requestedBatchId) {

  if (
    requestedBatchId &&
    String(requestedBatchId).trim()
  ) {
    return String(requestedBatchId).trim();
  }

  return "BATCH-" +
    ("000" + nextBatchSequence()).slice(-3);
}


// -----------------------------------------------------------------------------
// Request body helper
// -----------------------------------------------------------------------------

function getRequestBody(request) {

  if (!request) {
    return {};
  }

  /*
   * Scripted REST API request.body.data contains the
   * parsed JSON object when Content-Type is application/json.
   */

  if (request.body && request.body.data) {
    return request.body.data;
  }

  /*
   * Some ServiceNow runtimes expose the parsed body directly.
   */

  if (request.body) {
    return request.body;
  }

  return {};
}


// -----------------------------------------------------------------------------
// Base64 validation
// -----------------------------------------------------------------------------

function cleanBase64(value) {

  if (value === null || value === undefined) {
    return "";
  }

  var result = String(value).trim();

  /*
   * Allow a data URI such as:
   *
   * data:application/pdf;base64,JVBERi0x...
   */

  if (result.indexOf("base64,") !== -1) {
    result = result.substring(
      result.indexOf("base64,") + 7
    );
  }

  /*
   * Remove accidental whitespace/newlines.
   */

  result = result.replace(/\s/g, "");

  return result;
}


function validateBase64(value) {

  var base64 = cleanBase64(value);

  if (!base64) {
    return false;
  }

  /*
   * Base64 should contain only:
   * A-Z
   * a-z
   * 0-9
   * +
   * /
   * =
   */

  return /^[A-Za-z0-9+/]*={0,2}$/.test(base64);
}


// -----------------------------------------------------------------------------
// Create ServiceNow attachment
// -----------------------------------------------------------------------------

function createAttachment(recordGr, cheque) {

  if (!recordGr) {
    throw new Error(
      "Cannot create attachment: cheque record is missing"
    );
  }

  var fileName =
    cheque.source_file_name ||
    cheque.file_name ||
    "cheque.pdf";

  var ext = extensionOf(fileName);

  if (
    ACCEPTED_EXTENSIONS.indexOf(ext) === -1
  ) {
    throw new Error(
      "Unsupported file type '" +
      ext +
      "' for " +
      fileName
    );
  }

  var base64 =
    cleanBase64(
      cheque.file_content_base64
    );

  if (!validateBase64(base64)) {
    throw new Error(
      "Invalid or empty Base64 content for " +
      fileName
    );
  }

  var contentType =
    cheque.content_type ||
    contentTypeForExtension(ext);

  var attachmentApi =
    new GlideSysAttachment();

  /*
   * writeBase64() stores the decoded Base64 data
   * directly as a ServiceNow attachment.
   */

  var attachmentSysId =
    attachmentApi.writeBase64(
      recordGr,
      fileName,
      contentType,
      base64
    );

  if (!attachmentSysId) {
    throw new Error(
      "ServiceNow failed to create attachment for " +
      fileName
    );
  }

  return String(attachmentSysId);
}


// -----------------------------------------------------------------------------
// Create batch record
// -----------------------------------------------------------------------------

function createBatch(batchId, files, workerThreads) {

  var batchGr =
    new GlideRecord(BATCH_TABLE);

  batchGr.initialize();

  batchGr.setValue(
    "batch_id",
    batchId
  );

  batchGr.setValue(
    "source_file_name",
    summarise(files)
  );

  batchGr.setValue(
    "storage_path",
    "sys_attachment:" + batchId
  );

  batchGr.setValue(
    "total_files",
    files.length
  );

  batchGr.setValue(
    "total_cheques",
    files.length
  );

  batchGr.setValue(
    "worker_threads",
    workerThreads
  );

  batchGr.setValue(
    "status",
    "PROCESSING"
  );

  batchGr.setValue(
    "submitted_at",
    new GlideDateTime()
  );

  var batchSysId =
    batchGr.insert();

  if (!batchSysId) {
    throw new Error(
      "Failed to create batch record"
    );
  }

  return {
    sysId: String(batchSysId),
    record: batchGr
  };
}


// -----------------------------------------------------------------------------
// Create cheque record
// -----------------------------------------------------------------------------

function createChequeRecord(
  batchId,
  cheque,
  used
) {

  var originalName =
    cheque.source_file_name ||
    cheque.file_name ||
    "unnamed.pdf";

  var ext =
    extensionOf(originalName);

  var requestedChequeId =
    cheque.cheque_id;

  var chequeId;

  if (
    requestedChequeId &&
    String(requestedChequeId).trim()
  ) {

    chequeId =
      uniqueId(
        String(requestedChequeId).trim(),
        used
      );

  } else {

    chequeId =
      uniqueId(
        baseName(originalName),
        used
      );
  }


  var recordGr =
    new GlideRecord(RECORD_TABLE);

  recordGr.initialize();

  recordGr.setValue(
    "batch_id",
    batchId
  );

  recordGr.setValue(
    "cheque_id",
    chequeId
  );

  recordGr.setValue(
    "source_file_name",
    originalName
  );

  recordGr.setValue(
    "page_number",
    Number(cheque.page_number) || 1
  );


  /*
   * Unsupported files are recorded as failed instead
   * of crashing the entire batch.
   */

  if (
    ACCEPTED_EXTENSIONS.indexOf(ext) === -1
  ) {

    recordGr.setValue(
      "status",
      "OCR_FAILED"
    );

    recordGr.setValue(
      "error_message",
      "unsupported file type '" +
      ext +
      "'"
    );

    recordGr.setValue(
      "needs_review",
      true
    );

    var failedSysId =
      recordGr.insert();

    if (!failedSysId) {
      throw new Error(
        "Failed to create cheque record for " +
        originalName
      );
    }

    return {
      sysId: String(failedSysId),
      status: "OCR_FAILED",
      chequeId: chequeId
    };
  }


  /*
   * Create the cheque record first because
   * GlideSysAttachment.writeBase64() needs a
   * GlideRecord to attach the file to.
   */

  var recordSysId =
    recordGr.insert();

  if (!recordSysId) {
    throw new Error(
      "Failed to create cheque record for " +
      originalName
    );
  }


  /*
   * Reload the record so the GlideRecord is
   * definitely positioned on the inserted record.
   */

  recordGr =
    new GlideRecord(RECORD_TABLE);

  if (
    !recordGr.get(recordSysId)
  ) {
    throw new Error(
      "Could not reload cheque record " +
      recordSysId
    );
  }


  try {

    var attachmentSysId =
      createAttachment(
        recordGr,
        cheque
      );

    recordGr.setValue(
      "attachment_sys_id",
      attachmentSysId
    );

    recordGr.setValue(
      "status",
      "PENDING"
    );

    recordGr.update();


    return {
      sysId: String(recordSysId),
      status: "PENDING",
      chequeId: chequeId,
      attachmentSysId: attachmentSysId
    };

  } catch (attachmentError) {

    recordGr.setValue(
      "status",
      "OCR_FAILED"
    );

    recordGr.setValue(
      "error_message",
      truncate(
        attachmentError.message ||
        String(attachmentError),
        1000
      )
    );

    recordGr.setValue(
      "needs_review",
      true
    );

    recordGr.update();

    return {
      sysId: String(recordSysId),
      status: "OCR_FAILED",
      chequeId: chequeId,
      error: attachmentError.message ||
        String(attachmentError)
    };
  }
}


// -----------------------------------------------------------------------------
// STATUS / POLLING
// -----------------------------------------------------------------------------
//
// The browser polls through the EXISTING POST /process resource:
//
//   { "action": "status", "batch_id": "BATCH-123" }
//
// This deliberately avoids a separate GET /batches resource. That is important
// because the current ServiceNow Scripted REST API already has the POST
// /process resource, while the GET resource was the source of:
//
//   "Requested URI does not represent any resource"
// -----------------------------------------------------------------------------

function getBatchStatus(request, response) {
  try {
    var body = getRequestBody(request);
    var batchId = body.batch_id || body.batchId;

    if (!batchId || !String(batchId).trim()) {
      return badRequest(response, "batch_id is required");
    }

    batchId = String(batchId).trim();

    var batchGr = new GlideRecord(BATCH_TABLE);

    if (!batchGr.get("batch_id", batchId)) {
      response.setStatus(404);
      response.setBody({
        error: {
          code: "BATCH_NOT_FOUND",
          message: "No such batch: " + batchId
        }
      });
      return response;
    }

    var records = [];
    var recGr = new GlideRecord(RECORD_TABLE);

    recGr.addQuery("batch_id", batchId);
    recGr.orderBy("sys_id");
    recGr.query();

    var processedCount = 0;
    var failedCount = 0;

    while (recGr.next()) {
      var chequeStatus =
        String(recGr.getValue("status") || "");

      if (chequeStatus === "PROCESSED") {
        processedCount++;
      } else if (chequeStatus === "OCR_FAILED") {
        failedCount++;
      }

      records.push(
        buildStatusChequeDto(recGr)
      );
    }

    var totalCheques = records.length;
    var statusValue =
      String(batchGr.getValue("status") || "PROCESSING");

    var openCount = 0;

    for (var i = 0; i < records.length; i++) {
      if (
        records[i].status === "PENDING" ||
        records[i].status === "PROCESSING"
      ) {
        openCount++;
      }
    }

    if (
      totalCheques > 0 &&
      openCount === 0
    ) {
      statusValue = "COMPLETED";
    }

    var processingSeconds = null;
    var storedSeconds =
      batchGr.getValue("processing_time_seconds");

    if (
      storedSeconds !== null &&
      storedSeconds !== undefined &&
      storedSeconds !== ""
    ) {
      processingSeconds =
        parseFloat(storedSeconds);

      if (isNaN(processingSeconds)) {
        processingSeconds = null;
      }
    }

    var throughput = null;

    if (
      processingSeconds !== null &&
      processingSeconds > 0 &&
      totalCheques > 0 &&
      statusValue === "COMPLETED"
    ) {
      throughput =
        Math.round(
          (processedCount / processingSeconds) * 10
        ) / 10;
    }

    response.setStatus(200);

    response.setBody({
      status: statusValue,
      batchId: batchId,

      totalFiles:
        parseInt(
          batchGr.getValue("total_files"),
          10
        ) || totalCheques,

      totalCheques: totalCheques,
      processedCount: processedCount,
      failedCount: failedCount,

      processingTimeSeconds:
        processingSeconds,

      throughputChequesPerSec:
        throughput,

      results: records
    });

    return response;

  } catch (error) {
    gs.error(
      "[CTS OCR] getBatchStatus failed: " +
      String(
        error && error.message
          ? error.message
          : error
      )
    );

    return serverError(
      response,
      error
    );
  }
}


function buildStatusChequeDto(gr) {
  var batchId =
    gr.getValue("batch_id");

  var chequeId =
    gr.getValue("cheque_id");

  /*
   * These URLs are informational. The current batch processor does not need
   * them to poll, but keeping them here makes the response compatible with
   * the normal cheque DTO shape.
   */
  var base =
    "/api/x_2210302_gear_up/cheque_ocr/cheques/batches/" +
    encodeURIComponent(batchId) +
    "/cheques/" +
    encodeURIComponent(chequeId);

  return {
    batchId: batchId,
    chequeId: chequeId,

    fileName:
      gr.getValue("source_file_name"),

    pageNumber:
      parseInt(
        gr.getValue("page_number"),
        10
      ) || 1,

    status:
      gr.getValue("status") ||
      "PENDING",

    accountNumber:
      fieldResultForStatus(
        gr.getValue("account_number"),
        gr.getValue(
          "account_number_confidence_percent"
        )
      ),

    accountHolderName:
      fieldResultForStatus(
        gr.getValue("account_holder_name"),
        gr.getValue(
          "account_holder_confidence_percent"
        )
      ),

    chequeDate:
      fieldResultForStatus(
        gr.getValue("cheque_date"),
        gr.getValue(
          "cheque_date_confidence_percent"
        )
      ),

    amountInWords:
      fieldResultForStatus(
        gr.getValue("amount_in_words"),
        gr.getValue(
          "amount_in_words_confidence_percent"
        )
      ),

    amountInFigures:
      fieldResultForStatus(
        gr.getValue("amount_in_figures"),
        gr.getValue(
          "amount_in_figures_confidence_percent"
        )
      ),

    needsReview:
      String(
        gr.getValue("needs_review")
      ) === "1" ||
      String(
        gr.getValue("needs_review")
      ).toLowerCase() === "true",

    reviewReasons:
      splitStatusReasons(
        gr.getValue("review_reasons")
      ),

    verifiedAccountNumber:
      gr.getValue("verified_account_number") ||
      null,

    verifiedBy:
      gr.getDisplayValue("verified_by") ||
      null,

    verifiedAt:
      gr.getValue("verified_at") ||
      null,

    workerThreadName:
      gr.getValue("worker_thread_name") ||
      null,

    ocrDurationMs:
      toStatusIntOrNull(
        gr.getValue("ocr_duration_ms")
      ),

    errorMessage:
      gr.getValue("error_message") ||
      null,

    imageUrl:
      base + "/image",

    fileUrl:
      base + "/file"
  };
}


function fieldResultForStatus(
  value,
  confidence
) {
  var v =
    value === null ||
    value === undefined ||
    String(value) === ""
      ? null
      : String(value);

  var c = null;

  if (
    confidence !== null &&
    confidence !== undefined &&
    confidence !== ""
  ) {
    var n =
      parseFloat(confidence);

    c =
      isNaN(n)
        ? null
        : Math.round(n * 100) / 100;
  }

  return {
    value: v,
    confidencePercent:
      v === null
        ? null
        : c
  };
}


function splitStatusReasons(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return [];
  }

  return String(value)
    .split(";")
    .map(function(reason) {
      return String(reason).trim();
    })
    .filter(function(reason) {
      return reason.length > 0;
    });
}


function toStatusIntOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  var n =
    parseInt(value, 10);

  return isNaN(n)
    ? null
    : n;
}


// -----------------------------------------------------------------------------
// Main batch processing method
// -----------------------------------------------------------------------------

function processBatch(request, response) {

  try {

    var body =
      getRequestBody(request);


    
    /*
     * STATUS MODE
     *
     * Use the same POST /process Scripted REST resource for polling.
     * This prevents the browser from calling a GET resource that is not
     * registered in the ServiceNow instance.
     */
    if (
      String(body.action || "").toLowerCase() ===
      "status"
    ) {
      return getBatchStatus(
        request,
        response
      );
    }

// ---------------------------------------------------------------------
    // Read JSON payload
    // ---------------------------------------------------------------------

    var files =
      body.cheques;

    if (!files) {
      files = [];
    }

    if (!Array.isArray(files)) {

      return badRequest(
        response,
        "The 'cheques' property must be an array"
      );
    }


    if (files.length === 0) {

      return badRequest(
        response,
        "No cheques supplied. Send cheque files in the 'cheques' array."
      );
    }


    if (
      !unlimited() &&
      files.length > maxCheques()
    ) {

      return badRequest(
        response,
        files.length +
        " files given — maximum " +
        maxCheques() +
        " per request"
      );
    }


    // ---------------------------------------------------------------------
    // Worker threads
    // ---------------------------------------------------------------------

    var requestedThreads =
      body.worker_threads;

    if (
      requestedThreads === null ||
      requestedThreads === undefined ||
      requestedThreads === ""
    ) {
      requestedThreads =
        defaultWorkerThreads();
    }

    requestedThreads =
      parseInt(
        requestedThreads,
        10
      );

    if (isNaN(requestedThreads)) {
      requestedThreads =
        defaultWorkerThreads();
    }


    var ceiling =
      maxWorkerThreads();


    var poolSize =
      Math.max(
        1,
        Math.min(
          requestedThreads,
          ceiling
        )
      );


    // ---------------------------------------------------------------------
    // OCR URL
    // ---------------------------------------------------------------------

    var customOcrUrl =
      body.ocr_service_url;

    if (
      customOcrUrl &&
      String(customOcrUrl).trim()
    ) {

      customOcrUrl =
        String(customOcrUrl)
          .trim()
          .replace(/\/+$/, "");

      /*
       * Keep this request-specific URL available
       * to the event/processing layer if the
       * application stores it.
       */

      gs.info(
        "[CTS OCR] Request OCR URL: " +
        customOcrUrl
      );
    }


    // ---------------------------------------------------------------------
    // Batch ID
    // ---------------------------------------------------------------------

    var batchId =
      generateBatchId(
        body.batch_id
      );


    // ---------------------------------------------------------------------
    // Prevent accidental duplicate batch IDs
    // ---------------------------------------------------------------------

    var existingBatch =
      new GlideRecord(BATCH_TABLE);

    existingBatch.addQuery(
      "batch_id",
      batchId
    );

    existingBatch.setLimit(1);

    existingBatch.query();

    if (existingBatch.next()) {

      return badRequest(
        response,
        "Batch '" +
        batchId +
        "' already exists"
      );
    }


    // ---------------------------------------------------------------------
    // Create batch
    // ---------------------------------------------------------------------

    var batch =
      createBatch(
        batchId,
        files,
        poolSize
      );


    var used = {};

    var totalCheques = 0;

    var createdRecords = [];

    var failedCount = 0;


    // ---------------------------------------------------------------------
    // Create cheque records + attachments
    // ---------------------------------------------------------------------

    for (
      var i = 0;
      i < files.length;
      i++
    ) {

      var cheque =
        files[i];

      if (!cheque) {
        continue;
      }


      var created =
        createChequeRecord(
          batchId,
          cheque,
          used
        );


      createdRecords.push(
        created
      );

      totalCheques++;


      if (
        created.status ===
        "OCR_FAILED"
      ) {
        failedCount++;
      }
    }


    // ---------------------------------------------------------------------
    // Update batch totals
    // ---------------------------------------------------------------------

    var updateBatch =
      new GlideRecord(BATCH_TABLE);

    if (
      !updateBatch.get(
        batch.sysId
      )
    ) {

      throw new Error(
        "Could not reload batch " +
        batchId
      );
    }


    updateBatch.setValue(
      "total_cheques",
      totalCheques
    );

    updateBatch.setValue(
      "total_files",
      files.length
    );

    updateBatch.setValue(
      "worker_threads",
      poolSize
    );


    /*
     * If every file failed before OCR, there is no
     * point in putting the batch into processing.
     */

    if (
      totalCheques > 0 &&
      failedCount === totalCheques
    ) {

      updateBatch.setValue(
        "status",
        "COMPLETED"
      );

    } else {

      updateBatch.setValue(
        "status",
        "PROCESSING"
      );
    }


    updateBatch.update();


    // ---------------------------------------------------------------------
    // Queue ServiceNow processing event
    // ---------------------------------------------------------------------

    /*
     * IMPORTANT:
     *
     * The event handler must be the ServiceNow-side
     * equivalent of the old Node.js ocrWorker.js.
     *
     * It should receive:
     *
     *   parm1 = batchId
     *   parm2 = workerThreads
     *   parm3 = customOcrUrl
     *
     * and process the records using ocrServiceClient.js.
     *
     * We do NOT use the Node.js ocrWorker.js here.
     */

    if (failedCount < totalCheques) {

      gs.eventQueue(
        "x_2210302_gear_up.process_batch",
        updateBatch,
        batchId,
        String(poolSize),
        customOcrUrl || ""
      );
    }


    // ---------------------------------------------------------------------
    // Response
    // ---------------------------------------------------------------------

    response.setStatus(200);

    response.setBody({

      status:
        failedCount === totalCheques
          ? "COMPLETED"
          : "PROCESSING",

      batchId:
        batchId,

      totalFiles:
        files.length,

      totalCheques:
        totalCheques,

      workerThreads:
        poolSize,

      failedCount:
        failedCount,

      message:
        failedCount === totalCheques
          ? "No files could be queued for OCR."
          : "Batch accepted for OCR processing."
    });


  } catch (error) {

    gs.error(
      "[CTS OCR] processBatch failed: " +
      String(
        error &&
        error.message
          ? error.message
          : error
      )
    );

    return serverError(
      response,
      error
    );
  }
}


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function summarise(files) {

  if (!files || files.length === 0) {
    return "No files";
  }

  var first =
    files[0].source_file_name ||
    files[0].file_name ||
    "unnamed.pdf";


  return files.length === 1
    ? first
    : first +
      " (+" +
      (files.length - 1) +
      " more)";
}


function truncate(value, max) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  var stringValue =
    String(value);

  if (
    stringValue.length <= max
  ) {
    return stringValue;
  }

  return stringValue.substring(
    0,
    max
  );
}


function badRequest(
  response,
  message
) {

  response.setStatus(400);

  response.setBody({
    error: {
      code: "BAD_REQUEST",
      message: message
    }
  });

  return response;
}


function serverError(
  response,
  error
) {

  var message =
    error &&
    error.message
      ? error.message
      : String(error);


  response.setStatus(500);

  response.setBody({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: message
    }
  });

  return response;
}


// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {

  getConfig: getConfig,

  processBatch: processBatch,

  getBatchStatus: getBatchStatus,

  maxCheques: maxCheques,

  defaultWorkerThreads:
    defaultWorkerThreads,

  maxWorkerThreads:
    maxWorkerThreads,

  ACCEPTED_EXTENSIONS:
    ACCEPTED_EXTENSIONS
};