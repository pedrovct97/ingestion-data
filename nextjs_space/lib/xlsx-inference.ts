import * as XLSX from 'xlsx';

export interface InferredColumn {
  name: string;
  type: string;
}

const SAMPLE_ROWS = 100;
const VALIDATION_ROWS = 500;

// Normaliza o nome informado pelo usuario para o padrao tecnico usado em S3,
// DynamoDB, Glue Crawler e Lambda.
export function normalizeTableName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Valida a regra minima para novos datasets manuais: comecar por letra e usar
// apenas minusculas, numeros e underscore.
export function validateTableName(tableName: string): string | null {
  if (!tableName) return 'Nome da tabela é obrigatório';
  if (/\s/.test(tableName)) return 'Nome não pode conter espaços';
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    return 'Use apenas letras minúsculas, números e underscore (ex.: vendas_sap).';
  }
  return null;
}

// Infere um tipo simples a partir das primeiras linhas do XLSX. Essa inferencia
// serve como sugestao inicial; o usuario ainda pode revisar o schema antes de
// salvar no DynamoDB.
function inferTypeFromValues(values: unknown[]): string {
  const nonEmpty = values.filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== ''
  );
  if (nonEmpty.length === 0) return 'string';

  const allBool = nonEmpty.every((v) => {
    const s = String(v).toLowerCase().trim();
    return ['true', 'false', 'sim', 'não', 'nao', 'yes', 'no', '0', '1'].includes(s);
  });
  if (allBool && nonEmpty.length >= 2) return 'boolean';

  const allInt = nonEmpty.every((v) => {
    if (typeof v === 'number') return Number.isInteger(v);
    const n = Number(String(v).replace(',', '.'));
    return !Number.isNaN(n) && Number.isInteger(n);
  });
  if (allInt) return 'integer';

  const allFloat = nonEmpty.every((v) => {
    if (typeof v === 'number') return !Number.isNaN(v);
    const n = Number(String(v).replace(',', '.'));
    return !Number.isNaN(n);
  });
  if (allFloat) return 'decimal';

  const datePattern = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}/;
  const allDate = nonEmpty.every((v) => {
    if (v instanceof Date) return true;
    const s = String(v);
    return datePattern.test(s) || !Number.isNaN(Date.parse(s));
  });
  if (allDate && nonEmpty.length >= 2) return 'date';

  return 'string';
}

// Le a primeira aba do XLSX, usa a primeira linha como cabecalho e infere tipos
// com base em ate SAMPLE_ROWS linhas de dados.
export function inferColumnsFromXlsx(buffer: Buffer): InferredColumn[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(worksheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });

  const headerRow = rows[0] || [];
  const dataRows = rows.slice(1, 1 + SAMPLE_ROWS);

  const headers = headerRow
    .map((column) => String(column ?? '').trim())
    .filter((columnName) => columnName.length > 0);

  return headers.map((name, colIndex) => {
    const columnValues = dataRows.map((row) => row[colIndex]);
    return {
      name,
      type: inferTypeFromValues(columnValues),
    };
  });
}

// Retorna apenas os nomes do cabecalho para validacao rapida de upload.
export function getXlsxHeaderNames(buffer: Buffer): string[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(worksheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });

  const headerRow = rows[0] || [];
  return headerRow
    .map((column) => String(column ?? '').trim())
    .filter((columnName) => columnName.length > 0);
}

function readXlsxRows(buffer: Buffer): (string | number | boolean | Date | null)[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(worksheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });
}

function getXlsxHeaderCells(buffer: Buffer) {
  const rows = readXlsxRows(buffer);
  return (rows[0] || [])
    .map((value, index) => {
      const raw = String(value ?? '');
      return {
        index,
        raw,
        trimmed: raw.trim(),
      };
    })
    .filter((header) => header.raw.length > 0 || header.trimmed.length > 0);
}

function isEmptyCell(value: unknown) {
  return value === null || value === undefined || String(value).trim() === '';
}

function isValidValueForType(value: unknown, type: string) {
  if (isEmptyCell(value)) return true;
  const normalizedType = type.toLowerCase().trim();
  const raw = String(value).trim();

  if (normalizedType === 'string') return true;

  if (normalizedType === 'integer') {
    if (typeof value === 'number') return Number.isInteger(value);
    return /^-?\d+$/.test(raw);
  }

  if (normalizedType === 'decimal') {
    if (typeof value === 'number') return !Number.isNaN(value);
    return /^-?\d+(?:[.,]\d+)?$/.test(raw);
  }

  if (normalizedType === 'boolean') {
    return ['true', 'false', 'sim', 'nao', 'não', 'yes', 'no', '0', '1'].includes(
      raw.toLowerCase()
    );
  }

  if (normalizedType === 'date') {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    return !Number.isNaN(Date.parse(raw)) || /^\d{2}\/\d{2}\/\d{4}$/.test(raw);
  }

  return true;
}

export interface ColumnValidationResult {
  valid: boolean;
  fileHeaders: string[];
  expectedColumns: string[];
  missingInFile: string[];
  unexpectedInFile: string[];
  headerIssues: Array<{
    column: string;
    corrected: string;
    message: string;
  }>;
  typeIssues: Array<{
    column: string;
    expectedType: string;
    rowNumber: number;
    value: string;
    message: string;
  }>;
}

// Confere se cada coluna do schema existe no cabecalho real do .xlsx.
// Colunas extras sao informadas para o usuario, mas o criterio de "valid" hoje
// exige apenas que as colunas esperadas estejam presentes.
export function validateSchemaAgainstXlsx(
  buffer: Buffer,
  expectedColumns: InferredColumn[]
): ColumnValidationResult {
  const rows = readXlsxRows(buffer);
  const headerCells = getXlsxHeaderCells(buffer);
  const fileHeaders = headerCells.map((header) => header.trimmed).filter(Boolean);
  const expectedNames = expectedColumns.map((c) => c.name.trim()).filter(Boolean);
  const fileSet = new Set(fileHeaders);
  const expectedSet = new Set(expectedNames);

  const missingInFile = expectedNames.filter((name) => !fileSet.has(name));
  const unexpectedInFile = fileHeaders.filter((name) => !expectedSet.has(name));
  const headerIssues = headerCells
    .filter((header) => header.raw !== header.trimmed)
    .map((header) => ({
      column: header.raw,
      corrected: header.trimmed,
      message: `Coluna "${header.raw}" possui espaço antes ou depois do nome. Corrija para "${header.trimmed}".`,
    }));
  const headerIndexByName = new Map(
    headerCells.map((header) => [header.trimmed, header.index] as const)
  );
  const typeIssues: ColumnValidationResult['typeIssues'] = [];

  for (const expected of expectedColumns) {
    const columnName = expected.name.trim();
    const columnIndex = headerIndexByName.get(columnName);
    if (columnIndex === undefined) continue;

    const dataRows = rows.slice(1, 1 + VALIDATION_ROWS);
    for (let index = 0; index < dataRows.length; index += 1) {
      const value = dataRows[index]?.[columnIndex];
      if (isValidValueForType(value, expected.type)) continue;

      typeIssues.push({
        column: columnName,
        expectedType: expected.type,
        rowNumber: index + 2,
        value: String(value ?? ''),
        message: `Coluna "${columnName}" espera tipo ${expected.type}, mas encontrou "${String(value ?? '')}" na linha ${index + 2}.`,
      });

      if (typeIssues.length >= 20) break;
    }
  }

  return {
    valid:
      missingInFile.length === 0 &&
      headerIssues.length === 0 &&
      typeIssues.length === 0 &&
      expectedNames.length > 0,
    fileHeaders,
    expectedColumns: expectedNames,
    missingInFile,
    unexpectedInFile,
    headerIssues,
    typeIssues,
  };
}

// Monta mensagem amigavel para erro de schema antes de enviar arquivo ao S3.
export function formatColumnValidationError(result: ColumnValidationResult): string {
  const parts: string[] = [];
  if (result.missingInFile.length > 0) {
    parts.push(
      `Colunas definidas no schema mas ausentes no arquivo: ${result.missingInFile.join(', ')}`
    );
  }
  if (result.headerIssues.length > 0) {
    parts.push(
      `Colunas com espaço no início/fim do nome: ${result.headerIssues
        .map((issue) => `"${issue.column}" deve ser "${issue.corrected}"`)
        .join(', ')}`
    );
  }
  if (result.typeIssues.length > 0) {
    const groupedIssues = new Map<string, {
      column: string;
      expectedType: string;
      values: Set<string>;
    }>();

    for (const issue of result.typeIssues) {
      const key = `${issue.column}|${issue.expectedType}`;
      const current =
        groupedIssues.get(key) ||
        {
          column: issue.column,
          expectedType: issue.expectedType,
          values: new Set<string>(),
        };
      current.values.add(issue.value);
      groupedIssues.set(key, current);
    }

    const message = Array.from(groupedIssues.values())
      .map(
        (issue) =>
          `${issue.column} espera ${issue.expectedType}; corrija os valores ${Array.from(issue.values)
            .map((value) => `"${value}"`)
            .join(', ')}`
      )
      .join('; ');

    parts.push(`Valores incompatíveis com o tipo do schema: ${message}`);
  }
  if (result.fileHeaders.length > 0) {
    parts.push(`Colunas encontradas no arquivo: ${result.fileHeaders.join(', ')}`);
  }
  if (result.unexpectedInFile.length > 0) {
    parts.push(
      `(O arquivo também contém colunas não listadas no schema: ${result.unexpectedInFile.join(', ')})`
    );
  }
  return parts.join('. ');
}

// Parser usado por rotas que recebem o schema serializado vindo da UI.
export function parseColumnsJson(columnsJson: string): InferredColumn[] | null {
  try {
    const parsed = JSON.parse(columnsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map((col: { name?: string; type?: string }) => ({
      name: String(col.name ?? '').trim(),
      type: String(col.type ?? 'string').trim().toLowerCase() || 'string',
    }));
  } catch {
    return null;
  }
}
