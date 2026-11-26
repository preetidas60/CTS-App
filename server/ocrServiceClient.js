/**
 * ocrServiceClient.js
 * -------------------
 *
 * ServiceNow -> Python CTS Cheque OCR client.
 *
 * IMPORTANT:
 *
 * ServiceNow NEVER sends a local filesystem path.
 *
 * Final flow:
 *
 *   sys_attachment
 *        |
 *        v
 *   GlideSysAttachment.getContentBase64()
 *        |
 *        v
 *   JSON fileContentBase64
 *        |
 *        v
 *   Python /ocr/page
 *        |
 *        v
 *   temporary Python file
 *        |
 *        v
 *   PaddleOCR
 */

import {
    GlideSysAttachment,
    GlideRecord
} from "@servicenow/glide";

import {
    RESTMessageV2
} from "@servicenow/glide/sn_ws";


var ACTIVE_OCR_URL =
    "https://9fba-2409-40e6-1d-fbff-48ba-84df-56b1-712a.ngrok-free.app";


var DEFAULT_TIMEOUT_MS =
    600000;


var MAX_ATTACHMENT_BYTES =
    20 * 1024 * 1024;


/* ============================================================================
 * URL
 * ========================================================================== */

function getOcrServiceUrl() {

    return String(
        ACTIVE_OCR_URL || ""
    )
        .trim()
        .replace(
            /\/+$/,
            ""
        );
}


function setOcrServiceUrl(
    url
) {

    if (
        url &&
        String(url).trim()
    ) {

        ACTIVE_OCR_URL =
            String(url)
                .trim()
                .replace(
                    /\/+$/,
                    ""
                );
    }

    return getOcrServiceUrl();
}


function resolveOcrServiceUrl(
    customUrl
) {

    if (
        customUrl &&
        String(customUrl).trim()
    ) {

        return String(customUrl)
            .trim()
            .replace(
                /\/+$/,
                ""
            );
    }

    return getOcrServiceUrl();
}


/* ============================================================================
 * HTTP
 * ========================================================================== */

function postJson(
    endpointPath,
    payload,
    timeoutMs,
    customUrl
) {

    var baseUrl =
        resolveOcrServiceUrl(
            customUrl
        );


    if (
        !baseUrl
    ) {

        throw new Error(
            "OCR service URL is empty."
        );
    }


    if (
        !endpointPath
    ) {

        throw new Error(
            "OCR endpoint path is empty."
        );
    }


    var request =
        new RESTMessageV2();


    request.setHttpMethod(
        "POST"
    );


    request.setEndpoint(
        baseUrl +
        endpointPath
    );


    request.setRequestHeader(
        "Content-Type",
        "application/json"
    );


    request.setRequestHeader(
        "Accept",
        "application/json"
    );


    /*
     * ngrok warning bypass.
     */
    request.setRequestHeader(
        "ngrok-skip-browser-warning",
        "true"
    );


    request.setRequestHeader(
        "User-Agent",
        "CTS-Cheque-OCR-ServiceNow/4.0"
    );


    request.setHttpTimeout(
        timeoutMs ||
        DEFAULT_TIMEOUT_MS
    );


    /*
     * Never log Base64 itself.
     */
    var requestBody =
        JSON.stringify(
            payload
        );


    gs.info(
        "[CTS OCR] POST " +
        baseUrl +
        endpointPath
    );


    gs.info(
        "[CTS OCR] Request body chars=" +
        requestBody.length
    );


    if (
        payload &&
        payload.fileContentBase64
    ) {

        gs.info(
            "[CTS OCR] Base64 present. chars=" +
            String(
                payload.fileContentBase64
            ).length
        );

    } else {

        gs.error(
            "[CTS OCR] Base64 is MISSING from request."
        );

        throw new Error(
            "fileContentBase64 is empty."
        );
    }


    request.setRequestBody(
        requestBody
    );


    var response =
        request.execute();


    var status =
        response.getStatusCode();


    var body =
        response.getBody();


    gs.info(
        "[CTS OCR] HTTP " +
        status +
        " from " +
        endpointPath
    );


    if (
        status < 200 ||
        status >= 300
    ) {

        throw new Error(
            "OCR service returned HTTP " +
            status +
            ": " +
            String(
                body || ""
            ).substring(
                0,
                3000
            )
        );
    }


    if (
        !body
    ) {

        throw new Error(
            "OCR service returned an empty response from " +
            endpointPath
        );
    }


    try {

        return JSON.parse(
            body
        );

    } catch (ex) {

        throw new Error(
            "OCR service returned invalid JSON from " +
            endpointPath +
            ": " +
            String(
                body
            ).substring(
                0,
                3000
            )
        );
    }
}


/* ============================================================================
 * Attachment
 * ========================================================================== */

function getAttachmentRecord(
    attachmentSysId
) {

    if (
        !attachmentSysId
    ) {

        throw new Error(
            "attachmentSysId is required."
        );
    }


    var attachment =
        new GlideRecord(
            "sys_attachment"
        );


    if (
        !attachment.get(
            attachmentSysId
        )
    ) {

        throw new Error(
            "Attachment not found: " +
            attachmentSysId
        );
    }


    return attachment;
}


/**
 * Read the ServiceNow attachment and convert it to raw Base64.
 */
function getAttachmentBase64(
    attachmentSysId
) {

    var attachment =
        getAttachmentRecord(
            attachmentSysId
        );


    var fileName =
        attachment.getValue(
            "file_name"
        );


    var contentType =
        attachment.getValue(
            "content_type"
        );


    var size =
        parseInt(
            attachment.getValue(
                "size_bytes"
            ),
            10
        ) || 0;


    if (
        !fileName
    ) {

        throw new Error(
            "Attachment has no file name."
        );
    }


    if (
        size <= 0
    ) {

        throw new Error(
            "Attachment is empty: " +
            fileName
        );
    }


    if (
        size >
        MAX_ATTACHMENT_BYTES
    ) {

        throw new Error(
            "Attachment '" +
            fileName +
            "' is " +
            size +
            " bytes. " +
            "Maximum supported size is " +
            MAX_ATTACHMENT_BYTES +
            " bytes."
        );
    }


    gs.info(
        "[CTS OCR] Reading attachment: " +
        fileName +
        " bytes=" +
        size
    );


    var attachmentApi =
        new GlideSysAttachment();


    /*
     * ServiceNow decodes the attachment and returns Base64.
     */
    var base64 =
        attachmentApi.getContentBase64(
            attachment
        );


    if (
        !base64
    ) {

        throw new Error(
            "ServiceNow returned empty Base64 for " +
            fileName
        );
    }


    var clean =
        String(base64)
            .trim()
            .replace(
                /\s/g,
                ""
            );


    /*
     * Protect against a data URI.
     */
    var marker =
        clean.indexOf(
            "base64,"
        );


    if (
        marker >= 0
    ) {

        clean =
            clean.substring(
                marker + 7
            );
    }


    if (
        !clean
    ) {

        throw new Error(
            "Base64 became empty after cleaning for " +
            fileName
        );
    }


    /*
     * Base64 validation.
     */
    if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(
            clean
        )
    ) {

        throw new Error(
            "Invalid Base64 returned by ServiceNow for " +
            fileName
        );
    }


    /*
     * Base64 must have a length divisible by 4.
     */
    if (
        clean.length % 4 !== 0
    ) {

        throw new Error(
            "Invalid Base64 length for " +
            fileName +
            ": " +
            clean.length
        );
    }


    gs.info(
        "[CTS OCR] Attachment Base64 ready. " +
        "file=" +
        fileName +
        " chars=" +
        clean.length
    );


    return {

        base64:
            clean,

        fileName:
            fileName,

        contentType:
            contentType ||
            "application/octet-stream",

        sizeBytes:
            size
    };
}


/* ============================================================================
 * OCR
 * ========================================================================== */

function ocrPage(
    attachmentSysId,
    fileName,
    pageNumber,
    customUrl
) {

    pageNumber =
        Number(
            pageNumber
        ) || 1;


    if (
        pageNumber < 1
    ) {

        pageNumber = 1;
    }


    var attachment =
        getAttachmentRecord(
            attachmentSysId
        );


    var attachmentData =
        getAttachmentBase64(
            attachmentSysId
        );


    var payload = {

        /*
         * Python accepts this field but does not require it.
         *
         * ServiceNow must NOT send a ServiceNow filesystem path.
         */
        pdfPath: "",

        fileName:
            fileName ||
            attachmentData.fileName,

        contentType:
            attachmentData.contentType,

        fileContentBase64:
            attachmentData.base64,

        pageNumber:
            pageNumber
    };


    if (
        !payload.fileContentBase64
    ) {

        throw new Error(
            "Refusing OCR request: fileContentBase64 is empty."
        );
    }


    gs.info(
        "[CTS OCR] Sending Base64 OCR request. " +
        "file=" +
        attachmentData.fileName +
        " page=" +
        pageNumber +
        " bytes=" +
        attachmentData.sizeBytes +
        " base64Chars=" +
        attachmentData.base64.length
    );


    var result =
        postJson(
            "/ocr/page",
            payload,
            DEFAULT_TIMEOUT_MS,
            customUrl
        );


    if (
        !result ||
        typeof result !== "object"
    ) {

        throw new Error(
            "OCR service returned an invalid result."
        );
    }


    return normalizeOcrResult(
        result
    );
}


/* ============================================================================
 * Page count
 * ========================================================================== */

function getPageCount(
    attachmentSysId,
    fileName,
    customUrl
) {

    var attachmentData =
        getAttachmentBase64(
            attachmentSysId
        );


    var result =
        postJson(
            "/pdf/page-count",
            {

                pdfPath: "",

                fileName:
                    fileName ||
                    attachmentData.fileName,

                contentType:
                    attachmentData.contentType,

                fileContentBase64:
                    attachmentData.base64

            },
            300000,
            customUrl
        );


    var count =
        Number(
            result.pageCount
        );


    return count > 0
        ? count
        : 1;
}


/* ============================================================================
 * Render
 * ========================================================================== */

function renderPage(
    attachmentSysId,
    fileName,
    pageNumber,
    scale,
    customUrl
) {

    pageNumber =
        Number(
            pageNumber
        ) || 1;


    scale =
        Number(
            scale
        ) || 2.5;


    if (
        pageNumber < 1
    ) {

        pageNumber = 1;
    }


    if (
        scale < 0.5
    ) {

        scale = 0.5;
    }


    if (
        scale > 6
    ) {

        scale = 6;
    }


    var attachmentData =
        getAttachmentBase64(
            attachmentSysId
        );


    var baseUrl =
        resolveOcrServiceUrl(
            customUrl
        );


    var request =
        new RESTMessageV2();


    request.setHttpMethod(
        "POST"
    );


    request.setEndpoint(
        baseUrl +
        "/render/page"
    );


    request.setRequestHeader(
        "Content-Type",
        "application/json"
    );


    request.setRequestHeader(
        "Accept",
        "image/png"
    );


    request.setRequestHeader(
        "ngrok-skip-browser-warning",
        "true"
    );


    request.setRequestHeader(
        "User-Agent",
        "CTS-Cheque-OCR-ServiceNow/4.0"
    );


    request.setHttpTimeout(
        DEFAULT_TIMEOUT_MS
    );


    request.setRequestBody(
        JSON.stringify({

            pdfPath: "",

            fileName:
                fileName ||
                attachmentData.fileName,

            contentType:
                attachmentData.contentType,

            fileContentBase64:
                attachmentData.base64,

            pageNumber:
                pageNumber,

            scale:
                scale
        })
    );


    var response =
        request.execute();


    var status =
        response.getStatusCode();


    if (
        status < 200 ||
        status >= 300
    ) {

        throw new Error(
            "Render failed. HTTP " +
            status +
            ": " +
            String(
                response.getBody() ||
                ""
            ).substring(
                0,
                2000
            )
        );
    }


    return response.getBody();
}


/* ============================================================================
 * OCR response normalization
 * ========================================================================== */

function normalizeOcrResult(
    result
) {

    var normalized = {};


    normalized.pageNumber =
        firstDefined(
            result.pageNumber,
            result.page_number,
            1
        );


    normalized.accountNumber =
        firstDefined(
            result.accountNumber,
            result.account_number
        );


    normalized.accountNumberConfidencePercent =
        firstDefined(
            result.accountNumberConfidencePercent,
            result.account_number_confidence_percent,
            result.accountNumberOcrConf
        );


    normalized.accountHolderName =
        firstDefined(
            result.accountHolderName,
            result.account_holder_name
        );


    normalized.accountHolderNameConfidencePercent =
        firstDefined(
            result.accountHolderNameConfidencePercent,
            result.accountHolderConfidencePercent,
            result.accountHolderOcrConf,
            result.account_holder_confidence_percent,
            result.account_holder_ocr_conf
        );


    normalized.accountHolderOcrConf =
        normalized.accountHolderNameConfidencePercent;


    normalized.accountHolderConfidencePercent =
        normalized.accountHolderNameConfidencePercent;


    normalized.chequeDate =
        firstDefined(
            result.chequeDate,
            result.cheque_date
        );


    normalized.chequeDateConfidencePercent =
        firstDefined(
            result.chequeDateConfidencePercent,
            result.cheque_date_confidence_percent,
            result.chequeDateOcrConf
        );


    normalized.amountInWords =
        firstDefined(
            result.amountInWords,
            result.amount_in_words
        );


    normalized.amountInWordsConfidencePercent =
        firstDefined(
            result.amountInWordsConfidencePercent,
            result.amount_in_words_confidence_percent,
            result.amountInWordsOcrConf
        );


    normalized.amountInFigures =
        firstDefined(
            result.amountInFigures,
            result.amount_in_figures
        );


    normalized.amountInFiguresConfidencePercent =
        firstDefined(
            result.amountInFiguresConfidencePercent,
            result.amount_in_figures_confidence_percent,
            result.amountInFiguresOcrConf
        );


    normalized.needsReview =
        toBoolean(
            firstDefined(
                result.needsReview,
                result.needs_review,
                false
            )
        );


    normalized.reviewReasons =
        normalizeReviewReasons(
            firstDefined(
                result.reviewReasons,
                result.review_reasons,
                []
            )
        );


    normalized.rawTextLines =
        normalizeArray(
            firstDefined(
                result.rawTextLines,
                result.raw_text_lines,
                []
            )
        );


    normalized.ocrDurationMs =
        firstDefined(
            result.ocrDurationMs,
            result.ocr_duration_ms,
            0
        );


    /*
     * Preserve unknown fields.
     */
    for (
        var key in result
    ) {

        if (
            result.hasOwnProperty(
                key
            ) &&
            normalized[key] === undefined
        ) {

            normalized[key] =
                result[key];
        }
    }


    return normalized;
}


/* ============================================================================
 * Helpers
 * ========================================================================== */

function firstDefined() {

    for (
        var i = 0;
        i < arguments.length;
        i++
    ) {

        var value =
            arguments[i];


        if (
            value !== null &&
            value !== undefined &&
            value !== ""
        ) {

            return value;
        }
    }


    return null;
}


function toBoolean(
    value
) {

    if (
        value === true ||
        value === 1
    ) {

        return true;
    }


    if (
        typeof value === "string"
    ) {

        var normalized =
            value
                .trim()
                .toLowerCase();


        return (
            normalized === "true" ||
            normalized === "1" ||
            normalized === "yes"
        );
    }


    return false;
}


function normalizeArray(
    value
) {

    if (
        value === null ||
        value === undefined
    ) {

        return [];
    }


    if (
        Array.isArray(value)
    ) {

        return value;
    }


    return [
        String(value)
    ];
}


function normalizeReviewReasons(
    reasons
) {

    if (
        reasons === null ||
        reasons === undefined
    ) {

        return [];
    }


    if (
        Array.isArray(reasons)
    ) {

        return reasons
            .map(
                function(reason) {
                    return String(
                        reason
                    ).trim();
                }
            )
            .filter(
                function(reason) {
                    return reason.length > 0;
                }
            );
    }


    if (
        typeof reasons === "string"
    ) {

        if (
            !reasons.trim()
        ) {

            return [];
        }


        return reasons
            .split(";")
            .map(
                function(reason) {
                    return String(
                        reason
                    ).trim();
                }
            )
            .filter(
                function(reason) {
                    return reason.length > 0;
                }
            );
    }


    return [
        String(reasons)
    ];
}


/* ============================================================================
 * Exports
 * ========================================================================== */

module.exports = {

    getOcrServiceUrl:
        getOcrServiceUrl,

    setOcrServiceUrl:
        setOcrServiceUrl,

    ensureEnginePool:
        ensureEnginePool,

    getPageCount:
        getPageCount,

    ocrPage:
        ocrPage,

    renderPage:
        renderPage
};


/* ============================================================================
 * Ensure pool
 * ========================================================================== */

function ensureEnginePool(
    size,
    customUrl
) {

    var requested =
        Number(size) || 1;


    if (
        requested < 1
    ) {

        requested = 1;
    }


    var result =
        postJson(
            "/pool/ensure",
            {
                size: requested
            },
            300000,
            customUrl
        );


    return result;
}