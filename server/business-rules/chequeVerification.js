import { GlideDateTime } from "@servicenow/glide";

/**
 * CTS Cheque OCR - Cheque Verification
 *
 * When verified_account_number is populated:
 *
 * - set verified_at
 * - clear needs_review
 */
export function chequeVerification(
  current,
  previous
) {

  var verified =
    current.getValue(
      "verified_account_number"
    );


  if (!verified) {
    return;
  }


  var previousValue =
    previous
      ? previous.getValue(
          "verified_account_number"
        )
      : "";


  if (
    verified !== previousValue
  ) {

    current.setValue(
      "verified_at",
      new GlideDateTime()
    );


    current.setValue(
      "needs_review",
      false
    );
  }
}