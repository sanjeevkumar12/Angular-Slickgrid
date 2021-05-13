import { Injectable, Optional } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
// @ts-ignore
import * as ExcelBuilder from 'excel-builder-webpacker';
import { Subject } from 'rxjs';
import * as moment_ from 'moment-mini';
const moment = moment_; // patch to fix rollup "moment has no default export" issue, document here https://github.com/rollup/rollup/issues/670

import { ExcelWorkbook } from './../models/excelWorkbook.interface';
import { ExcelStylesheet } from './../models/excelStylesheet.interface';
import {
  Column,
  ExcelCellFormat,
  ExcelExportOption,
  ExcelMetadata,
  ExcelWorksheet,
  FieldType,
  FileType,
  GridOption,
  KeyTitlePair,
  Locale,
} from '../models/index';
import { Constants } from '../constants';
import { exportWithFormatterWhenDefined } from '../formatters/formatterUtilities';
import { addWhiteSpaces, deepCopy, getTranslationPrefix, mapMomentDateFormatWithFieldType, sanitizeHtmlToText, titleCase } from './utilities';


const DEFAULT_EXPORT_OPTIONS: ExcelExportOption = {
  filename: 'export',
  format: FileType.xlsx
};

@Injectable()
export class ExcelExportService {
  private _fileFormat = FileType.xlsx;
  private _hasColumnTitlePreHeader = false;
  private _dataView: any;
  private _grid: any;
  private _locales!: Locale;
  private _columnHeaders!: Array<KeyTitlePair>;
  private _groupedColumnHeaders!: Array<KeyTitlePair>;
  private _hasGroupedItems = false;
  private _excelExportOptions!: ExcelExportOption;
  private _sheet!: ExcelWorksheet;
  private _stylesheet!: ExcelStylesheet;
  private _stylesheetFormats: any;
  private _workbook!: ExcelWorkbook;
  onGridBeforeExportToExcel = new Subject<boolean>();
  onGridAfterExportToExcel = new Subject<{ blob?: Blob; filename: string; format?: string; }>();

  constructor(@Optional() private readonly translate: TranslateService) { }

  private get datasetIdName(): string {
    return this._gridOptions && this._gridOptions.datasetIdPropertyName || 'id';
  }

  /** Getter for the Grid Options pulled through the Grid Object */
  private get _gridOptions(): GridOption {
    return (this._grid && this._grid.getOptions) ? this._grid.getOptions() : {};
  }

  /**
   * Initialize the Export Service
   * @param grid
   * @param dataView
   */
  init(grid: any, dataView: any): void {
    this._grid = grid;
    this._dataView = dataView;

    // get locales provided by user in forRoot or else use default English locales via the Constants
    this._locales = this._gridOptions && this._gridOptions.locales || Constants.locales;

    if (this._gridOptions.enableTranslate && (!this.translate || !this.translate.instant)) {
      throw new Error('[Angular-Slickgrid] requires "ngx-translate" to be installed and configured when the grid option "enableTranslate" is enabled.');
    }
  }

  /**
   * Function to export the Grid result to an Excel CSV format using javascript for it to produce the CSV file.
   * This is a WYSIWYG export to file output (What You See is What You Get)
   *
   * NOTES: The column position needs to match perfectly the JSON Object position because of the way we are pulling the data,
   * which means that if any column(s) got moved in the UI, it has to be reflected in the JSON array output as well
   *
   * Example: exportToExcel({ format: FileType.csv, delimiter: DelimiterType.comma })
   */
  exportToExcel(options?: ExcelExportOption): Promise<boolean> {
    if (!this._grid || !this._dataView) {
      throw new Error('[Angular-Slickgrid] it seems that the SlickGrid & DataView objects are not initialized did you forget to enable the grid option flag "enableExcelExport"?');
    }

    return new Promise((resolve, reject) => {
      this.onGridBeforeExportToExcel.next(true);
      this._excelExportOptions = deepCopy({ ...DEFAULT_EXPORT_OPTIONS, ...this._gridOptions.excelExportOptions, ...options });
      this._fileFormat = this._excelExportOptions.format || FileType.xlsx;

      // prepare the Excel Workbook & Sheet
      this._workbook = new ExcelBuilder.Workbook();
      this._sheet = new ExcelBuilder.Worksheet({ name: this._excelExportOptions.sheetName || 'Sheet1' });

      // add any Excel Format/Stylesheet to current Workbook
      this._stylesheet = this._workbook.getStyleSheet();
      const boldFormatter = this._stylesheet.createFormat({ font: { bold: true } });
      const stringFormatter = this._stylesheet.createFormat({ format: '@' });
      const numberFormatter = this._stylesheet.createFormat({ format: '0' });
      const usdFormatter = this._stylesheet.createFormat({ format: '$#,##0.00' });
      this._stylesheetFormats = {
        boldFormatter,
        dollarFormatter: usdFormatter,
        numberFormatter,
        stringFormatter,
      };

      // get the CSV output from the grid data
      const dataOutput = this.getDataOutput();

      // trigger a download file
      // wrap it into a setTimeout so that the EventAggregator has enough time to start a pre-process like showing a spinner
      setTimeout(async () => {
        try {
          if (this._gridOptions && this._gridOptions.excelExportOptions && this._gridOptions.excelExportOptions.customExcelHeader) {
            this._gridOptions.excelExportOptions.customExcelHeader(this._workbook, this._sheet);
          }

          const columns = this._grid && this._grid.getColumns && this._grid.getColumns() || [];
          this._sheet.setColumns(this.getColumnStyles(columns));

          const currentSheetData = this._sheet.data;
          let finalOutput = currentSheetData;
          if (Array.isArray(currentSheetData) && Array.isArray(dataOutput)) {
            finalOutput = this._sheet.data.concat(dataOutput);
          }

          this._sheet.setData(finalOutput);
          this._workbook.addWorksheet(this._sheet);

          const mimeType = this._fileFormat === FileType.xls ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet ';
          const excelBlob = await ExcelBuilder.Builder.createFile(this._workbook, { type: 'blob', mimeType });
          const downloadOptions = {
            filename: `${this._excelExportOptions.filename}.${this._fileFormat}`,
            format: this._fileFormat
          };

          // start downloading but add the Blob property only on the start download not on the event itself
          this.startDownloadFile({ ...downloadOptions, blob: excelBlob, data: this._sheet.data });
          this.onGridAfterExportToExcel.next(downloadOptions);
          resolve(true);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Takes a positive integer and returns the corresponding column name.
   * dealing with the Excel column position is a bit tricky since the first 26 columns are single char (A,B,...) but after that it becomes double char (AA,AB,...)
   * so we must first see if we are in the first section of 26 chars, if that is the case we just concatenate 1 (1st row) so it becomes (A1, B1, ...)
   * and again if we go 26, we need to add yet again an extra prefix (AA1, AB1, ...) and so goes the cycle
   * @param {number} colIndex - The positive integer to convert to a column name.
   * @return {string}  The column name.
   */
  getExcelColumnNameByIndex(colIndex: number): string {
    const letters = 'ZABCDEFGHIJKLMNOPQRSTUVWXY';

    let nextPos = Math.floor(colIndex / 26);
    const lastPos = Math.floor(colIndex % 26);
    if (lastPos === 0) {
      nextPos--;
    }

    if (colIndex > 26) {
      return this.getExcelColumnNameByIndex(nextPos) + letters[lastPos];
    }

    return letters[lastPos] + '';
  }

  /**
   * Triggers download file with file format.
   * IE(6-10) are not supported
   * All other browsers will use plain javascript on client side to produce a file download.
   * @param options
   */
  startDownloadFile(options: { filename: string, blob: Blob, data: any[] }) {
    // IE(6-10) don't support javascript download and our service doesn't support either so throw an error, we have to make a round trip to the Web Server for exporting
    if (navigator.appName === 'Microsoft Internet Explorer') {
      throw new Error('Microsoft Internet Explorer 6 to 10 do not support javascript export to Excel. Please upgrade your browser.');
    }

    // when using IE/Edge, then use different download call
    if (typeof navigator.msSaveOrOpenBlob === 'function') {
      navigator.msSaveOrOpenBlob(options.blob, options.filename);
    } else {
      // this trick will generate a temp <a /> tag
      // the code will then trigger a hidden click for it to start downloading
      const link = document && document.createElement('a');
      const url = URL.createObjectURL(options.blob);

      if (link && document) {
        link.textContent = 'download';
        link.href = url;
        link.setAttribute('download', options.filename);

        // set the visibility to hidden so there is no effect on your web-layout
        link.style.visibility = 'hidden';

        // this part will append the anchor tag, trigger a click (for download to start) and finally remove the tag once completed
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    }
  }

  /** use different Excel Stylesheet Format as per the Field Type */
  useCellFormatByFieldType(data: string | Date | moment_.Moment, fieldType: FieldType): ExcelCellFormat | string {
    let outputData: ExcelCellFormat | string | Date | moment_.Moment = data;
    switch (fieldType) {
      case FieldType.dateTime:
      case FieldType.dateTimeIso:
      case FieldType.dateTimeShortIso:
      case FieldType.dateTimeIsoAmPm:
      case FieldType.dateTimeIsoAM_PM:
      case FieldType.dateEuro:
      case FieldType.dateEuroShort:
      case FieldType.dateTimeEuro:
      case FieldType.dateTimeShortEuro:
      case FieldType.dateTimeEuroAmPm:
      case FieldType.dateTimeEuroAM_PM:
      case FieldType.dateTimeEuroShort:
      case FieldType.dateTimeEuroShortAmPm:
      case FieldType.dateUs:
      case FieldType.dateUsShort:
      case FieldType.dateTimeUs:
      case FieldType.dateTimeShortUs:
      case FieldType.dateTimeUsAmPm:
      case FieldType.dateTimeUsAM_PM:
      case FieldType.dateTimeUsShort:
      case FieldType.dateTimeUsShortAmPm:
      case FieldType.dateUtc:
      case FieldType.date:
      case FieldType.dateIso:
        outputData = data;
        if (data) {
          const defaultDateFormat = mapMomentDateFormatWithFieldType(fieldType);
          const isDateValid = moment(data as string, defaultDateFormat, false).isValid();
          const outputDate = (data && isDateValid) ? moment(data as string).format(defaultDateFormat) : data;
          const dateFormatter = this._stylesheet.createFormat({ format: defaultDateFormat });
          outputData = { value: outputDate, metadata: { style: dateFormatter.id } };
        }
        break;
      case FieldType.number:
        const val = isNaN(+data) ? null : +data;
        outputData = { value: val, metadata: { style: this._stylesheetFormats.numberFormatter.id } };
        break;
      default:
        outputData = data;
    }
    return outputData as string;
  }

  // -----------------------
  // Private functions
  // -----------------------

  private getDataOutput(): string[][] | ExcelCellFormat[][] {
    const columns = this._grid && this._grid.getColumns && this._grid.getColumns() || [];

    // data variable which will hold all the fields data of a row
    const outputData: string[][] | ExcelCellFormat[][] = [];
    const columnHeaderStyle = this._gridOptions && this._gridOptions.excelExportOptions && this._gridOptions.excelExportOptions.columnHeaderStyle;
    let columnHeaderStyleId = this._stylesheetFormats.boldFormatter.id;
    if (columnHeaderStyle) {
      columnHeaderStyleId = this._stylesheet.createFormat(columnHeaderStyle).id;
    }

    // get all Grouped Column Header Titles when defined (from pre-header row)
    if (this._gridOptions.createPreHeaderPanel && this._gridOptions.showPreHeaderPanel && !this._gridOptions.enableDraggableGrouping) {
      // when having Grouped Header Titles (in the pre-header), then make the cell Bold & Aligned Center
      const boldCenterAlign = this._stylesheet.createFormat({ alignment: { horizontal: 'center' }, font: { bold: true } });
      (outputData as ExcelCellFormat[][]).push(this.getColumnGroupedHeaderTitlesData(columns, { style: boldCenterAlign && boldCenterAlign.id }));
      this._hasColumnTitlePreHeader = true;
    }

    // get all Column Header Titles (it might include a "Group by" title at A1 cell)
    // also style the headers, defaults to Bold but user could pass his own style
    (outputData as ExcelCellFormat[][]).push(this.getColumnHeaderData(columns, { style: columnHeaderStyleId }) as ExcelCellFormat[]);

    // Populate the rest of the Grid Data
    this.pushAllGridRowDataToArray(outputData as any, columns);

    return outputData;
  }

  /** Get each column style including a style for the width of each column */
  private getColumnStyles(columns: Column[]): any[] {
    const grouping = this._dataView && this._dataView.getGrouping && this._dataView.getGrouping();
    const columnStyles = [];
    if (Array.isArray(grouping) && grouping.length > 0) {
      columnStyles.push({
        bestFit: true,
        columnStyles: (this._gridOptions && this._gridOptions.excelExportOptions && this._gridOptions.excelExportOptions.customColumnWidth) || 10
      });
    }

    columns.forEach((columnDef: Column) => {
      const skippedField = columnDef.excludeFromExport || false;
      // if column width is 0, then we consider that field as a hidden field and should not be part of the export
      if ((columnDef.width === undefined || columnDef.width > 0) && !skippedField) {
        columnStyles.push({
          bestFit: true,
          width: columnDef.exportColumnWidth || (this._gridOptions && this._gridOptions.excelExportOptions && this._gridOptions.excelExportOptions.customColumnWidth) || 10
        });
      }
    });
    return columnStyles;
  }

  /**
   * Get all Grouped Header Titles and their keys, translate the title when required, and format them in Bold
   * @param {Array<Object>} columns - grid column definitions
   * @param {Object} metadata - Excel metadata
   * @returns {Object} array of Excel cell format
   */
  private getColumnGroupedHeaderTitlesData(columns: Column[], metadata: ExcelMetadata): Array<ExcelCellFormat> {
    let outputGroupedHeaderTitles: Array<ExcelCellFormat> = [];

    // get all Column Header Titles
    this._groupedColumnHeaders = this.getColumnGroupedHeaderTitles(columns) || [];
    if (this._groupedColumnHeaders && Array.isArray(this._groupedColumnHeaders) && this._groupedColumnHeaders.length > 0) {
      // add the header row + add a new line at the end of the row
      outputGroupedHeaderTitles = this._groupedColumnHeaders.map((header) => ({ value: header.title, metadata }));
    }

    // merge necessary cells (any grouped header titles)
    let colspanStartIndex = 0;
    const headersLn = this._groupedColumnHeaders.length;
    for (let cellIndex = 0; cellIndex < headersLn; cellIndex++) {
      if ((cellIndex + 1) === headersLn || ((cellIndex + 1) < headersLn && this._groupedColumnHeaders[cellIndex].title !== this._groupedColumnHeaders[cellIndex + 1].title)) {
        const leftExcelColumnChar = this.getExcelColumnNameByIndex(colspanStartIndex + 1);
        const rightExcelColumnChar = this.getExcelColumnNameByIndex(cellIndex + 1);
        this._sheet.mergeCells(`${leftExcelColumnChar}1`, `${rightExcelColumnChar}1`);

        // next group starts 1 column index away
        colspanStartIndex = cellIndex + 1;
      }
    }

    return outputGroupedHeaderTitles;
  }

  /** Get all column headers and format them in Bold */
  private getColumnHeaderData(columns: Column[], metadata: ExcelMetadata): Array<string | ExcelCellFormat> {
    let outputHeaderTitles: ExcelCellFormat[] = [];

    // get all Column Header Titles
    this._columnHeaders = this.getColumnHeaders(columns) || [];
    if (this._columnHeaders && Array.isArray(this._columnHeaders) && this._columnHeaders.length > 0) {
      // add the header row + add a new line at the end of the row
      outputHeaderTitles = this._columnHeaders.map((header) => ({ value: header.title, metadata }));
    }

    // do we have a Group by title?
    const groupTitle = this.getGroupColumnTitle();
    if (groupTitle) {
      outputHeaderTitles.unshift({ value: groupTitle, metadata });
    }

    return outputHeaderTitles;
  }

  private getGroupColumnTitle(): string | null {
    // Group By text, it could be set in the export options or from translation or if nothing is found then use the English constant text
    let groupByColumnHeader = this._excelExportOptions.groupingColumnHeaderTitle;
    if (!groupByColumnHeader && this._gridOptions.enableTranslate && this.translate && this.translate.currentLang && this.translate.instant) {
      groupByColumnHeader = this.translate.instant(`${getTranslationPrefix(this._gridOptions)}GROUP_BY`);
    } else if (!groupByColumnHeader) {
      groupByColumnHeader = this._locales && this._locales.TEXT_GROUP_BY;
    }

    // get grouped column titles and if found, we will add a "Group by" column at the first column index
    // if it's a CSV format, we'll escape the text in double quotes
    const grouping = this._dataView && this._dataView.getGrouping && this._dataView.getGrouping();
    if (Array.isArray(grouping) && grouping.length > 0) {
      this._hasGroupedItems = true;
      return groupByColumnHeader as string;
    } else {
      this._hasGroupedItems = false;
    }
    return null;
  }

  /**
   * Get all Grouped Header Titles and their keys, translate the title when required.
   * @param {Array<object>} columns of the grid
   */
  private getColumnGroupedHeaderTitles(columns: Column[]): Array<KeyTitlePair> {
    const groupedColumnHeaders: Array<KeyTitlePair> = [];

    if (columns && Array.isArray(columns)) {
      // Populate the Grouped Column Header, pull the columnGroup(Key) defined
      columns.forEach((columnDef: Column) => {
        let groupedHeaderTitle: string = '';
        if (columnDef.columnGroupKey && this._gridOptions.enableTranslate && this.translate && this.translate.currentLang && this.translate.instant) {
          groupedHeaderTitle = this.translate.instant(columnDef.columnGroupKey);
        } else {
          groupedHeaderTitle = columnDef.columnGroup as string;
        }
        const skippedField = columnDef.excludeFromExport || false;

        // if column width is 0px, then we consider that field as a hidden field and should not be part of the export
        if ((columnDef.width === undefined || columnDef.width > 0) && !skippedField) {
          groupedColumnHeaders.push({
            key: (columnDef.field || columnDef.id) as string,
            title: groupedHeaderTitle || '',
          });
        }
      });
    }
    return groupedColumnHeaders;
  }

  /**
   * Get all header titles and their keys, translate the title when required.
   * @param columns of the grid
   */
  private getColumnHeaders(columns: Column[]): Array<KeyTitlePair> {
    const columnHeaders: Array<KeyTitlePair> = [];

    if (columns && Array.isArray(columns)) {
      // Populate the Column Header, pull the name defined
      columns.forEach((columnDef) => {
        let headerTitle = '';
        if ((columnDef.headerKey || columnDef.nameKey) && this._gridOptions.enableTranslate && this.translate && this.translate.currentLang && this.translate.instant) {
          headerTitle = this.translate.instant((columnDef.headerKey || columnDef.nameKey) || ' ');
        } else {
          headerTitle = columnDef.name || titleCase(columnDef.field);
        }
        const skippedField = columnDef.excludeFromExport || false;

        // if column width is 0, then we consider that field as a hidden field and should not be part of the export
        if ((columnDef.width === undefined || columnDef.width > 0) && !skippedField) {
          columnHeaders.push({
            key: columnDef.field || columnDef.id,
            title: headerTitle
          });
        }
      });
    }
    return columnHeaders;
  }

  /**
   * Get all the grid row data and return that as an output string
   */
  private pushAllGridRowDataToArray(originalDataArray: string[][], columns: Column[]): Array<string[] | ExcelCellFormat[]> {
    const lineCount = this._dataView?.getLength() ?? 0;

    // loop through all the grid rows of data
    for (let rowNumber = 0; rowNumber < lineCount; rowNumber++) {
      const itemObj = this._dataView.getItem(rowNumber);
      if (itemObj) {
        // Normal row (not grouped by anything) would have an ID which was predefined in the Grid Columns definition
        if (itemObj[this.datasetIdName] !== null && itemObj[this.datasetIdName] !== undefined) {
          // get regular row item data
          originalDataArray.push(this.readRegularRowData(columns, rowNumber, itemObj));
        } else if (this._hasGroupedItems && itemObj.__groupTotals === undefined) {
          // get the group row
          originalDataArray.push([this.readGroupedTitleRow(itemObj)]);
        } else if (itemObj.__groupTotals) {
          // else if the row is a Group By and we have agreggators, then a property of '__groupTotals' would exist under that object
          originalDataArray.push(this.readGroupedTotalRow(columns, itemObj));
        }
      }
    }
    return originalDataArray;
  }

  /**
   * Get the data of a regular row (a row without grouping).
   * If the row has colspan, we will also merge the cells data
   * @param row
   * @param itemObj
   */
  private readRegularRowData(columns: Column[], row: number, itemObj: any): string[] {
    let idx = 0;
    const rowOutputStrings = [];
    const columnsLn = columns.length;
    let prevColspan: number | '*' = 1;
    let colspanStartIndex = 0;
    const itemMetadata = this._dataView.getItemMetadata(row);

    for (let col = 0; col < columnsLn; col++) {
      const columnDef = columns[col];
      const fieldType = columnDef.outputType || columnDef.type || FieldType.string;

      // skip excluded column
      if (columnDef.excludeFromExport) {
        continue;
      }

      // if we are grouping and are on 1st column index, we need to skip this column since it will be used later by the grouping text:: Group by [columnX]
      if (this._hasGroupedItems && idx === 0) {
        rowOutputStrings.push('');
      }

      let colspan = 1;
      let colspanColumnId;
      if (itemMetadata?.columns) {
        const metadata = itemMetadata?.columns;
        const columnData = metadata[columnDef.id] || metadata[col];
        if (!(prevColspan > 1 || (prevColspan === '*' && col > 0))) {
          prevColspan = columnData?.colspan ?? 1;
        }
        if (prevColspan === '*') {
          colspan = columns.length - col;
        } else {
          colspan = prevColspan;
          if (columnDef.id in metadata) {
            colspanColumnId = columnDef.id;
            colspanStartIndex = col;
          }
        }
      }

      // when using grid with colspan, we will merge some cells together
      if ((prevColspan === '*' && col > 0) || (prevColspan > 1 && columnDef.id !== colspanColumnId)) {
        // -- Merge Data
        // Excel row starts at 2 or at 3 when dealing with pre-header grouping
        const excelRowNumber = row + (this._hasColumnTitlePreHeader ? 3 : 2);

        if (typeof prevColspan === 'number' && (colspan - 1) === 1) {
          // partial column span
          const leftExcelColumnChar = this.getExcelColumnNameByIndex(colspanStartIndex + 1);
          const rightExcelColumnChar = this.getExcelColumnNameByIndex(col + 1);
          this._sheet.mergeCells(`${leftExcelColumnChar}${excelRowNumber}`, `${rightExcelColumnChar}${excelRowNumber}`);
          rowOutputStrings.push(''); // clear cell that won't be shown by a cell merge
        } else if (prevColspan === '*' && colspan === 1) {
          // full column span (from A1 until the last column)
          const rightExcelColumnChar = this.getExcelColumnNameByIndex(col + 1);
          this._sheet.mergeCells(`A${excelRowNumber}`, `${rightExcelColumnChar}${excelRowNumber}`);
        } else {
          rowOutputStrings.push(''); // clear cell that won't be shown by a cell merge
        }

        // decrement colspan until we reach colspan of 1 then proceed with cell merge OR full row merge when colspan is (*)
        if (typeof prevColspan === 'number' && prevColspan > 1) {
          colspan = prevColspan--;
        }
      } else {
        // -- Read Data & Push to Data Array
        // get the output by analyzing if we'll pull the value from the cell or from a formatter
        let itemData: ExcelCellFormat | string = exportWithFormatterWhenDefined(row, col, columnDef, itemObj, this._grid, this._excelExportOptions);

        // does the user want to sanitize the output data (remove HTML tags)?
        if (columnDef.sanitizeDataExport || this._excelExportOptions.sanitizeDataExport) {
          itemData = sanitizeHtmlToText(itemData as string);
        }

        // use different Excel Stylesheet Format as per the Field Type
        if (!columnDef.exportWithFormatter) {
          itemData = this.useCellFormatByFieldType(itemData as string, fieldType);
        }

        rowOutputStrings.push(itemData);
        idx++;
      }
    }

    return rowOutputStrings as string[];
  }

  /**
   * Get the grouped title(s) and its group title formatter, for example if we grouped by salesRep, the returned result would be:: 'Sales Rep: John Dow (2 items)'
   * @param itemObj
   */
  private readGroupedTitleRow(itemObj: any): string {
    const groupName = sanitizeHtmlToText(itemObj.title);

    if (this._excelExportOptions?.addGroupIndentation) {
      const collapsedSymbol = this._excelExportOptions?.groupCollapsedSymbol ?? '⮞';
      const expandedSymbol = this._excelExportOptions?.groupExpandedSymbol ?? '⮟';
      const chevron = itemObj.collapsed ? collapsedSymbol : expandedSymbol;
      return chevron + ' ' + addWhiteSpaces(5 * itemObj.level) + groupName;
    }
    return groupName;
  }

  /**
   * Get the grouped totals (below the regular rows), these are set by Slick Aggregators.
   * For example if we grouped by "salesRep" and we have a Sum Aggregator on "sales", then the returned output would be:: ["Sum 123$"]
   * @param itemObj
   */
  private readGroupedTotalRow(columns: Column[], itemObj: any): string[] {
    const groupingAggregatorRowText = this._excelExportOptions.groupingAggregatorRowText || '';
    const outputStrings = [groupingAggregatorRowText];

    columns.forEach((columnDef) => {
      let itemData = '';

      const skippedField = columnDef.excludeFromExport || false;

      // if there's a exportCustomGroupTotalsFormatter or groupTotalsFormatter, we will re-run it to get the exact same output as what is shown in UI
      if (columnDef.exportCustomGroupTotalsFormatter) {
        itemData = columnDef.exportCustomGroupTotalsFormatter(itemObj, columnDef);
      } else {
        if (columnDef.groupTotalsFormatter) {
          itemData = columnDef.groupTotalsFormatter(itemObj, columnDef);
        }
      }

      // does the user want to sanitize the output data (remove HTML tags)?
      if (columnDef.sanitizeDataExport || this._excelExportOptions.sanitizeDataExport) {
        itemData = sanitizeHtmlToText(itemData);
      }

      // add the column (unless user wants to skip it)
      if ((columnDef.width === undefined || columnDef.width > 0) && !skippedField) {
        outputStrings.push(itemData);
      }
    });

    return outputStrings;
  }
}
