/**
 * chequeEventHandlers.js
 * ----------------------
 *
 * ServiceNow background OCR worker.
 *
 * Event:
 *
 *     x_2210302_gear_up.process_batch
 *
 * Parameters:
 *
 *     parm1 = batchId
 *     parm2 = workerThreads
 *     parm3 = OCR service URL
 *
 *
 * IMPORTANT:
 *
 * This worker NEVER reads a local file path.
 *
 * It gets:
 *
 *     cheque record
 *          |
 *          v
 *     attachment_sys_id
 *          |
 *          v
 *     ocrServiceClient
 *          |
 *          v
 *     Base64
 *          |
 *          v
 *     Python OCR
 */

var OcrServiceClient =
    require("./ocrServiceClient.js");

var AmountParser =
    require("./amountParser.js");


var RECORD_TABLE =
    "x_2210302_gear_up_record";

var BATCH_TABLE =
    "x_2210302_gear_up_batch";


/* ============================================================================
 * EVENT
 * ========================================================================== */

function onProcessBatch(event) {

    var batchId =
        event.parm1
            ? String(event.parm1).trim()
            : "";

    var workerThreads =
        event.parm2
            ? parseInt(event.parm2, 10)
            : 1;

    if (!batchId) {

        gs.error(
            "[CTS OCR] PROCESS_BATCH event received without batchId"
        );

        return;
    }

    if (
        isNaN(workerThreads) ||
        workerThreads < 1
    ) {

        workerThreads = 1;
    }


    /*
     * IMPORTANT:
     *
     * Read OCR URL from the batch record.
     * Do NOT depend on event.parm3.
     */

    var customOcrUrl = "";

    var batchGr =
        new GlideRecord(
            "x_2210302_gear_up_batch"
        );

    batchGr.addQuery(
        "batch_id",
        batchId
    );

    batchGr.setLimit(1);

    batchGr.query();

    if (batchGr.next()) {

        if (
            batchGr.isValidField(
                "ocr_service_url"
            )
        ) {

            customOcrUrl =
                String(
                    batchGr.getValue(
                        "ocr_service_url"
                    ) || ""
                ).trim();
        }
    }


    gs.info(
        "[CTS OCR] PROCESS_BATCH event received. " +
        "batchId=" +
        batchId +
        " workerThreads=" +
        workerThreads +
        " customOcrUrl=" +
        (
            customOcrUrl
                ? customOcrUrl
                : "(default)"
        )
    );


    try {

        processQueuedBatch(
            batchId,
            workerThreads,
            customOcrUrl
        );

    } catch (ex) {

        var message =
            String(
                ex &&
                ex.message
                    ? ex.message
                    : ex
            );

        gs.error(
            "[CTS OCR] PROCESS_BATCH failed. " +
            "batchId=" +
            batchId +
            " error=" +
            message
        );

        markBatchFailed(
            batchId,
            message
        );
    }
}


/* ============================================================================
 * BATCH
 * ========================================================================== */

function processQueuedBatch(
    batchId,
    workerThreads,
    customOcrUrl
) {

    var batchStart =
        new GlideDateTime();


    var batchGr =
        new GlideRecord(
            BATCH_TABLE
        );


    if (
        !batchGr.get(
            "batch_id",
            batchId
        )
    ) {

        throw new Error(
            "Batch not found: " +
            batchId
        );
    }


    var recGr =
        new GlideRecord(
            RECORD_TABLE
        );


    recGr.addQuery(
        "batch_id",
        batchId
    );


    recGr.addQuery(
        "status",
        "PENDING"
    );


    recGr.orderBy(
        "sys_id"
    );


    recGr.query();


    var count = 0;


    while (
        recGr.next()
    ) {

        count++;


        processOneCheque(
            recGr,
            customOcrUrl
        );
    }


    gs.info(
        "[CTS OCR] Batch " +
        batchId +
        " processed " +
        count +
        " pending record(s)."
    );


    finishBatch(
        batchId,
        batchStart
    );
}


/* ============================================================================
 * ONE CHEQUE
 * ========================================================================== */

function processOneCheque(
    recGr,
    customOcrUrl
) {

    var start =
        new GlideDateTime();


    var chequeId =
        recGr.getValue(
            "cheque_id"
        );


    var attachmentSysId =
        recGr.getValue(
            "attachment_sys_id"
        );


    var fileName =
        recGr.getValue(
            "source_file_name"
        );


    var pageNumber =
        parseInt(
            recGr.getValue(
                "page_number"
            ),
            10
        ) || 1;


    if (
        !attachmentSysId
    ) {

        markChequeFailed(
            recGr,
            start,
            "No ServiceNow attachment is associated with this cheque."
        );

        return;
    }


    gs.info(
        "[CTS OCR] Processing cheque. " +
        "chequeId=" +
        chequeId +
        " attachment=" +
        attachmentSysId +
        " file=" +
        fileName +
        " page=" +
        pageNumber
    );


    /*
     * Mark PROCESSING.
     */

    recGr.setValue(
        "status",
        "PROCESSING"
    );


    recGr.setValue(
        "worker_thread_name",
        "servicenow-bg-event"
    );


    recGr.setValue(
        "ocr_start_time",
        start
    );


    recGr.setValue(
        "error_message",
        ""
    );


    recGr.update();


    try {

        /*
         * THIS IS THE IMPORTANT CALL.
         *
         * ocrServiceClient.js reads the ServiceNow attachment,
         * converts it to Base64 and sends:
         *
         *     fileContentBase64
         *
         * to:
         *
         *     POST /ocr/page
         */

        var result =
            OcrServiceClient.ocrPage(
                attachmentSysId,
                fileName,
                pageNumber,
                customOcrUrl
            );


        if (
            !result
        ) {

            throw new Error(
                "OCR service returned an empty result."
            );
        }


        /*
         * Store account number.
         */

        setIfPresent(
            recGr,
            "account_number",
            result.accountNumber
        );


        setIfPresent(
            recGr,
            "account_number_confidence_percent",
            result.accountNumberConfidencePercent
        );


        /*
         * Account holder.
         */

        setIfPresent(
            recGr,
            "account_holder_name",
            result.accountHolderName
        );


        setIfPresent(
            recGr,
            "account_holder_confidence_percent",
            firstDefined(
                result.accountHolderNameConfidencePercent,
                result.accountHolderConfidencePercent,
                result.accountHolderOcrConf
            )
        );


        /*
         * Date.
         */

        setIfPresent(
            recGr,
            "cheque_date",
            result.chequeDate
        );


        setIfPresent(
            recGr,
            "cheque_date_confidence_percent",
            result.chequeDateConfidencePercent
        );


        /*
         * Amount in words.
         */

        setIfPresent(
            recGr,
            "amount_in_words",
            truncate(
                result.amountInWords,
                500
            )
        );


        setIfPresent(
            recGr,
            "amount_in_words_confidence_percent",
            result.amountInWordsConfidencePercent
        );


        /*
         * Amount in figures.
         */

        setIfPresent(
            recGr,
            "amount_in_figures",
            result.amountInFigures
        );


        setIfPresent(
            recGr,
            "amount_in_figures_confidence_percent",
            result.amountInFiguresConfidencePercent
        );


        /*
         * Review state.
         */

        recGr.setValue(
            "needs_review",
            result.needsReview
                ? true
                : false
        );


        recGr.setValue(
            "review_reasons",
            truncate(
                joinReasons(
                    result.reviewReasons
                ),
                1000
            )
        );


        /*
         * Completed.
         */

        recGr.setValue(
            "status",
            "PROCESSED"
        );


        recGr.setValue(
            "error_message",
            ""
        );


        var end =
            new GlideDateTime();


        recGr.setValue(
            "ocr_end_time",
            end
        );


        recGr.setValue(
            "ocr_duration_ms",
            durationMs(
                start,
                end
            )
        );


        recGr.update();


        gs.info(
            "[CTS OCR] Cheque completed. " +
            "chequeId=" +
            chequeId +
            " status=PROCESSED"
        );


    } catch (ex) {

        var message =
            String(
                ex &&
                ex.message
                    ? ex.message
                    : ex
            );


        markChequeFailed(
            recGr,
            start,
            message
        );


        gs.error(
            "[CTS OCR] OCR FAILED. " +
            "chequeId=" +
            chequeId +
            " error=" +
            message
        );
    }
}


/* ============================================================================
 * FAILED CHEQUE
 * ========================================================================== */

function markChequeFailed(
    recGr,
    start,
    message
) {

    var end =
        new GlideDateTime();


    recGr.setValue(
        "status",
        "OCR_FAILED"
    );


    recGr.setValue(
        "error_message",
        truncate(
            message,
            1000
        )
    );


    recGr.setValue(
        "needs_review",
        true
    );


    recGr.setValue(
        "ocr_end_time",
        end
    );


    recGr.setValue(
        "ocr_duration_ms",
        durationMs(
            start,
            end
        )
    );


    recGr.update();
}


/* ============================================================================
 * FINISH BATCH
 * ========================================================================== */

function finishBatch(
    batchId,
    batchStart
) {

    var stillOpen =
        new GlideAggregate(
            RECORD_TABLE
        );


    stillOpen.addQuery(
        "batch_id",
        batchId
    );


    stillOpen.addQuery(
        "status",
        "IN",
        "PENDING,PROCESSING"
    );


    stillOpen.addAggregate(
        "COUNT"
    );


    stillOpen.query();


    if (
        stillOpen.next() &&
        parseInt(
            stillOpen.getAggregate(
                "COUNT"
            ),
            10
        ) > 0
    ) {

        gs.info(
            "[CTS OCR] Batch " +
            batchId +
            " still has open records."
        );

        return;
    }


    var processed =
        countByStatus(
            batchId,
            "PROCESSED"
        );


    var failed =
        countByStatus(
            batchId,
            "OCR_FAILED"
        );


    var total =
        countAll(
            batchId
        );


    var totalAmount =
        totalAmountForBatch(
            batchId
        );


    var batchGr =
        new GlideRecord(
            BATCH_TABLE
        );


    if (
        !batchGr.get(
            "batch_id",
            batchId
        )
    ) {

        gs.error(
            "[CTS OCR] Batch not found while finishing: " +
            batchId
        );

        return;
    }


    var end =
        new GlideDateTime();


    var seconds =
        durationSeconds(
            batchStart,
            end
        );


    batchGr.setValue(
        "status",
        "COMPLETED"
    );


    batchGr.setValue(
        "completed_at",
        end
    );


    batchGr.setValue(
        "processing_time_seconds",
        round(
            seconds
        )
    );


    batchGr.setValue(
        "processed_count",
        processed
    );


    batchGr.setValue(
        "failed_count",
        failed
    );


    if (
        batchGr.isValidField(
            "total_amount_in_figures"
        )
    ) {

        batchGr.setValue(
            "total_amount_in_figures",
            totalAmount
        );
    }


    if (
        batchGr.isValidField(
            "total_cheques"
        )
    ) {

        batchGr.setValue(
            "total_cheques",
            total
        );
    }


    batchGr.update();


    gs.info(
        "[CTS OCR] Batch completed. " +
        "batchId=" +
        batchId +
        " total=" +
        total +
        " processed=" +
        processed +
        " failed=" +
        failed +
        " amount=" +
        totalAmount
    );
}


/* ============================================================================
 * COUNTS
 * ========================================================================== */

function countByStatus(
    batchId,
    status
) {

    var ga =
        new GlideAggregate(
            RECORD_TABLE
        );


    ga.addQuery(
        "batch_id",
        batchId
    );


    ga.addQuery(
        "status",
        status
    );


    ga.addAggregate(
        "COUNT"
    );


    ga.query();


    if (
        ga.next()
    ) {

        return parseInt(
            ga.getAggregate(
                "COUNT"
            ),
            10
        ) || 0;
    }


    return 0;
}


function countAll(
    batchId
) {

    var ga =
        new GlideAggregate(
            RECORD_TABLE
        );


    ga.addQuery(
        "batch_id",
        batchId
    );


    ga.addAggregate(
        "COUNT"
    );


    ga.query();


    if (
        ga.next()
    ) {

        return parseInt(
            ga.getAggregate(
                "COUNT"
            ),
            10
        ) || 0;
    }


    return 0;
}


/* ============================================================================
 * AMOUNT
 * ========================================================================== */

function totalAmountForBatch(
    batchId
) {

    var total =
        null;


    var recGr =
        new GlideRecord(
            RECORD_TABLE
        );


    recGr.addQuery(
        "batch_id",
        batchId
    );


    recGr.query();


    while (
        recGr.next()
    ) {

        var rawAmount =
            recGr.getValue(
                "amount_in_figures"
            );


        if (
            !rawAmount
        ) {

            continue;
        }


        try {

            var parsed =
                AmountParser.parseAmount(
                    rawAmount
                );


            if (
                parsed !== null &&
                parsed !== undefined &&
                !isNaN(parsed)
            ) {

                total =
                    total === null
                        ? Number(parsed)
                        : total +
                          Number(parsed);
            }

        } catch (ex) {

            gs.warn(
                "[CTS OCR] Could not parse amount '" +
                rawAmount +
                "': " +
                String(
                    ex.message ||
                    ex
                )
            );
        }
    }


    return total;
}


/* ============================================================================
 * BATCH FAILURE
 * ========================================================================== */

function markBatchFailed(
    batchId,
    message
) {

    try {

        var batchGr =
            new GlideRecord(
                BATCH_TABLE
            );


        if (
            !batchGr.get(
                "batch_id",
                batchId
            )
        ) {

            return;
        }


        if (
            batchGr.getValue(
                "status"
            ) === "COMPLETED"
        ) {

            return;
        }


        batchGr.setValue(
            "status",
            "COMPLETED"
        );


        if (
            batchGr.isValidField(
                "failed_count"
            )
        ) {

            batchGr.setValue(
                "failed_count",
                countByStatus(
                    batchId,
                    "OCR_FAILED"
                )
            );
        }


        if (
            batchGr.isValidField(
                "completed_at"
            )
        ) {

            batchGr.setValue(
                "completed_at",
                new GlideDateTime()
            );
        }


        if (
            batchGr.isValidField(
                "error_message"
            )
        ) {

            batchGr.setValue(
                "error_message",
                truncate(
                    message,
                    1000
                )
            );
        }


        batchGr.update();


    } catch (innerError) {

        gs.error(
            "[CTS OCR] Could not mark failed batch: " +
            String(
                innerError.message ||
                innerError
            )
        );
    }
}


/* ============================================================================
 * HELPERS
 * ========================================================================== */

function setIfPresent(
    record,
    fieldName,
    value
) {

    if (
        value === null ||
        value === undefined
    ) {

        return;
    }


    if (
        !record.isValidField(
            fieldName
        )
    ) {

        gs.warn(
            "[CTS OCR] Field does not exist: " +
            fieldName
        );

        return;
    }


    record.setValue(
        fieldName,
        value
    );
}


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


function joinReasons(
    reasons
) {

    if (
        !reasons
    ) {

        return null;
    }


    if (
        typeof reasons === "string"
    ) {

        return reasons.trim()
            ? reasons
            : null;
    }


    if (
        !Array.isArray(reasons) ||
        reasons.length === 0
    ) {

        return null;
    }


    return reasons.join(
        "; "
    );
}


function truncate(
    value,
    max
) {

    if (
        value === null ||
        value === undefined
    ) {

        return null;
    }


    var text =
        String(value);


    return text.length <= max
        ? text
        : text.substring(
            0,
            max
        );
}


function durationMs(
    start,
    end
) {

    try {

        return GlideDateTime
            .subtract(
                start,
                end
            )
            .getNumericValue();

    } catch (ex) {

        return 0;
    }
}


function durationSeconds(
    start,
    end
) {

    return (
        durationMs(
            start,
            end
        ) / 1000.0
    );
}


function round(
    value
) {

    return Math.round(
        Number(value) * 100
    ) / 100;
}


/* ============================================================================
 * EXPORTS
 * ========================================================================== */

module.exports = {

    onProcessBatch:
        onProcessBatch,

    processQueuedBatch:
        processQueuedBatch,

    processOneCheque:
        processOneCheque,

    finishBatch:
        finishBatch
};