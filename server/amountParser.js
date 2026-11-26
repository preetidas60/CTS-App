/**
 * amountParser.js
 *
 * Parses OCR amount strings using the CTS/en-IN rules.
 */

function parseAmount(raw) {

  if (
      raw === null ||
      raw === undefined ||
      String(raw).trim() === ""
  ) {
      return null;
  }


  var cleaned =
      String(raw)
          .replace(
              /[^0-9.,]/g,
              ""
          );


  /*
   * Commas are grouping separators.
   */
  cleaned =
      cleaned.replace(
          /,/g,
          ""
      );


  /*
   * If multiple dots exist, the LAST dot is
   * treated as the decimal separator.
   */
  var lastDot =
      cleaned.lastIndexOf(".");


  if (
      lastDot >= 0
  ) {

      var beforeLastDot =
          cleaned
              .substring(
                  0,
                  lastDot
              )
              .replace(
                  /\./g,
                  ""
              );


      cleaned =
          beforeLastDot +
          cleaned.substring(
              lastDot
          );
  }


  /*
   * Currency-prefix OCR debris.
   *
   * Example:
   *
   * Rs. 4500/-
   *
   * becomes:
   *
   * .4500
   *
   * and must become:
   *
   * 4500
   */
  while (
      cleaned.startsWith(".")
  ) {

      cleaned =
          cleaned.substring(
              1
          );
  }


  if (
      cleaned.endsWith(".")
  ) {

      cleaned =
          cleaned.substring(
              0,
              cleaned.length - 1
          );
  }


  if (
      cleaned === ""
  ) {

      return null;
  }


  var value =
      Number(cleaned);


  if (
      !isFinite(value)
  ) {

      return null;
  }


  return value;
}


module.exports = {
  parseAmount:
      parseAmount
};