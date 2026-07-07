'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  Pencil,
} from 'lucide-react';
import ExecutionStatus from '../components/execution-status';
import { canCreateTables } from '@/lib/auth/roles';

const NEW_TABLE_OPTION = '__new_table__';

interface Column {
  name: string;
  type: string;
}

interface Table {
  tableName: string;
  displayName: string;
  requiredColumns: (string | Column)[];
  s3Prefix: string;
  description?: string;
}

interface ExecutionResult {
  id: string;
  executionArn: string;
  tableName: string;
  fileName: string;
  status: string;
}

const COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date'];

// Tela de upload manual de XLSX.
// Ela permite escolher uma tabela existente ou, para usuarios com permissao,
// criar uma tabela nova inferindo schema a partir do proprio arquivo.
export default function UploadPage() {
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const permissions = (session?.user as any)?.permissions;
  const isAdmin = canCreateTables(role, permissions);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [newTableName, setNewTableName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [execution, setExecution] = useState<ExecutionResult | null>(null);
  const [inferredColumns, setInferredColumns] = useState<Column[]>([]);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [showColumnEditor, setShowColumnEditor] = useState(false);

  const isNewTable = isAdmin && selectedTable === NEW_TABLE_OPTION;

  // Destaca colunas digitadas/inferidas que nao existem no cabecalho real do
  // arquivo, evitando erro posterior na Lambda.
  const columnMismatch = (name: string) =>
    fileHeaders.length > 0 && !fileHeaders.includes(name.trim());

  useEffect(() => {
    fetchTables();
  }, []);

  // Carrega apenas tabelas sourceType=file, pois esta tela trata ingestao manual.
  const fetchTables = async () => {
    try {
      const response = await fetch('/excel_ingestion/tables?sourceType=file&manualIngestionOnly=true');
      const data = await response.json();
      setTables(data.tables || []);
      if (data.tables?.length > 0) {
        setSelectedTable(data.tables[0].tableName);
      }
    } catch {
      setError('Erro ao carregar tabelas');
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) handleFileSelect(e.dataTransfer.files[0]);
  };

  // Selecionar arquivo ja inicia preview/validacao conforme o modo escolhido.
  const handleFileSelect = async (selectedFile: File) => {
    setError('');
    setSuccess('');
    setInferredColumns([]);
    setFileHeaders([]);
    setShowColumnEditor(false);

    if (!selectedFile.name.endsWith('.xlsx')) {
      setError('Apenas arquivos .xlsx são permitidos');
      return;
    }
    if (selectedFile.size > 50 * 1024 * 1024) {
      setError('Arquivo muito grande. Tamanho máximo: 50MB');
      return;
    }
    setFile(selectedFile);

    if (isNewTable) {
      await runPreview(selectedFile);
    } else if (selectedTable) {
      try {
        await runValidate(selectedFile, selectedTable);
      } catch (err: any) {
        setError(err?.message || 'Erro ao validar colunas');
      }
    }
  };

  // Preview nao salva nada; apenas retorna colunas inferidas para revisao.
  const runPreview = async (fileToPreview?: File) => {
    const targetFile = fileToPreview || file;
    if (!targetFile) return;

    setIsPreviewing(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', targetFile);
      const response = await fetch('/excel_ingestion/tables/preview', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao analisar arquivo');

      setInferredColumns(data.columns || []);
      setFileHeaders(data.fileHeaders || data.columns?.map((c: Column) => c.name) || []);
      setShowColumnEditor(true);
    } catch (err: any) {
      setError(err?.message || 'Erro ao inferir colunas');
    } finally {
      setIsPreviewing(false);
    }
  };

  // Validacao compara o cabecalho do XLSX com schema existente ou editado.
  const runValidate = async (
    fileToValidate?: File,
    tableName?: string,
    columns?: Column[]
  ) => {
    const targetFile = fileToValidate || file;
    const resolvedTable = tableName || getResolvedTableName();
    if (!targetFile || !resolvedTable) return true;

    const formData = new FormData();
    formData.append('file', targetFile);
    formData.append('tableName', resolvedTable);
    if (columns?.length) {
      formData.append('columns', JSON.stringify(columns));
    } else if (isNewTable && inferredColumns.length > 0) {
      formData.append('columns', JSON.stringify(inferredColumns));
    }

    const response = await fetch('/excel_ingestion/tables/validate', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      setError(data.error || 'Erro ao validar colunas');
      return false;
    }

    if (data.fileHeaders?.length) {
      setFileHeaders(data.fileHeaders);
    }

    if (!data.valid) {
      setError(data.error || 'Schema não corresponde ao arquivo Excel');
      return false;
    }

    return true;
  };

  const updateColumn = (index: number, field: 'name' | 'type', value: string) => {
    setInferredColumns((prev) =>
      prev.map((col, i) => (i === index ? { ...col, [field]: value } : col))
    );
  };

  const removeColumn = (index: number) => {
    setInferredColumns((prev) => prev.filter((_, i) => i !== index));
  };

  // Nome tecnico enviado ao backend. Para tabela nova, aplica a mesma regra de
  // normalizacao usada nas rotas para manter S3/Dynamo/Glue consistentes.
  const getResolvedTableName = (): string => {
    if (isNewTable) {
      return newTableName
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    }
    return selectedTable;
  };

  // Envia arquivo, schema opcional e tabela para o backend. O backend salva no
  // S3, sincroniza Dynamo se necessario e registra historico CRAWLING.
  const handleUpload = async () => {
    const tableName = getResolvedTableName();

    if (!file || !tableName) {
      setError(isNewTable ? 'Informe o nome da tabela e selecione um arquivo' : 'Selecione arquivo e tabela');
      return;
    }

    if (isNewTable && inferredColumns.length === 0) {
      setError('Analise o arquivo para detectar as colunas antes de continuar.');
      return;
    }

    const hasInvalidColumns =
      fileHeaders.length > 0 &&
      inferredColumns.some((col) => columnMismatch(col.name));

    if (hasInvalidColumns) {
      setError(
        'Existem colunas no schema que não existem no arquivo. Corrija os nomes destacados em vermelho.'
      );
      return;
    }

    setIsUploading(true);
    setError('');
    setSuccess('');
    setExecution(null);

    try {
      const valid = await runValidate(
        file,
        tableName,
        isNewTable ? inferredColumns : undefined
      );
      if (!valid) return;

      if (isNewTable) {
        const exists = tables.some((t) => t.tableName === tableName);
        if (!exists) {
          const createRes = await fetch('/excel_ingestion/tables/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tableName,
              displayName: newTableName.trim() || tableName,
              columns: inferredColumns,
            }),
          });
          const createData = await createRes.json();
          if (!createRes.ok) throw new Error(createData.error || 'Erro ao cadastrar tabela');
          await fetchTables();
        }
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('tableName', tableName);
      if (inferredColumns.length > 0) {
        formData.append('columns', JSON.stringify(inferredColumns));
      }

      const response = await fetch('/excel_ingestion/upload', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao enviar arquivo');

      setSuccess('Envio iniciado com sucesso.');
      setExecution(data.execution);
      setFile(null);
      setInferredColumns([]);
      setShowColumnEditor(false);
      setNewTableName('');
      if (isNewTable) setSelectedTable(tables[0]?.tableName || '');
    } catch (err: any) {
      setError(err?.message || 'Erro ao enviar arquivo');
    } finally {
      setIsUploading(false);
    }
  };

  const selectedTableData = tables.find((t) => t.tableName === selectedTable);

  const handleDownloadTemplate = async () => {
    if (!selectedTableData) return;
    setIsDownloadingTemplate(true);
    setError('');
    setSuccess('');

    try {
      const params = new URLSearchParams({ tableName: selectedTableData.tableName });
      const response = await fetch(`/excel_ingestion/tables/template?${params}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Erro ao gerar modelo da tabela');
      }

      const blob = await response.blob();
      const encodedFileName = response.headers.get('X-File-Name');
      const disposition = response.headers.get('Content-Disposition') || '';
      const fileName =
        (encodedFileName ? decodeURIComponent(encodedFileName) : null) ||
        disposition.match(/filename="([^"]+)"/)?.[1] ||
        `modelo_${selectedTableData.tableName}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSuccess(`Modelo baixado: ${fileName}`);
    } catch (err: any) {
      setError(err?.message || 'Erro ao baixar modelo da tabela');
    } finally {
      setIsDownloadingTemplate(false);
    }
  };

  const hasSchemaMismatch =
    fileHeaders.length > 0 &&
    inferredColumns.some((col) => columnMismatch(col.name));

  const canSubmit =
    file &&
    !hasSchemaMismatch &&
    (isNewTable
      ? newTableName.trim().length > 0 && inferredColumns.length > 0
      : selectedTable);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#730401] mb-1">Envio de Arquivos</h1>
        <p className="text-gray-500">
          {isAdmin
            ? 'Envie arquivos .xlsx para tabelas existentes ou cadastre uma nova tabela'
            : 'Envie arquivos .xlsx para tabelas existentes'}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <label className="block text-sm font-semibold text-gray-700 mb-3">
              Tabela de destino
            </label>
            <select
              value={selectedTable}
              onChange={(e) => {
                setSelectedTable(e.target.value);
                setInferredColumns([]);
                setShowColumnEditor(false);
                setError('');
              }}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
            >
              {isAdmin && <option value={NEW_TABLE_OPTION}>+ Carregar tabela nova</option>}
              {tables.map((table) => (
                <option key={table.tableName} value={table.tableName}>
                  {table.displayName}
                </option>
              ))}
            </select>

            {isNewTable ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">
                    Nome da nova tabela (sem espaços)
                  </label>
                  <input
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    placeholder="ex: vendas_sap_novas"
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#730401]/30"
                  />
                  {newTableName && (
                    <p className="text-xs text-gray-400 mt-1 font-mono">
                      ID: {getResolvedTableName() || '—'}
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-500 flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" />
                  Após selecionar o .xlsx, as colunas serão detectadas automaticamente para revisão.
                </p>
              </div>
            ) : (
              selectedTableData && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm text-gray-500 mb-2">{selectedTableData.description}</p>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Colunas configuradas
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadTemplate}
                      disabled={isDownloadingTemplate || selectedTableData.requiredColumns.length === 0}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 border border-[#730401]/20 text-[#730401] rounded-lg hover:bg-[#730401]/5 disabled:opacity-50 text-xs font-semibold whitespace-nowrap"
                    >
                      {isDownloadingTemplate ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      Baixar modelo
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTableData.requiredColumns.map((col: any, i: number) => {
                      const colName = typeof col === 'string' ? col : col.name;
                      const colType = typeof col === 'object' ? col.type : null;
                      return (
                        <span
                          key={`${colName}-${i}`}
                          className="px-2.5 py-1 bg-[#730401]/5 border border-[#730401]/20 text-[#730401] text-xs font-medium rounded-md"
                        >
                          {colName}
                          {colType ? ` (${colType})` : ''}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )
            )}
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <label className="block text-sm font-semibold text-gray-700 mb-3">Arquivo .xlsx</label>
            <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-blue-800">
              Antes de importar, salve o arquivo com o período no final do nome:
              <span className="font-mono font-semibold"> nome_da_tabela_YYYY_MM.xlsx</span>.
              Exemplos:
              <span className="font-mono"> de_para_custo_fixo_negocios_2026_05.xlsx</span> ou
              <span className="font-mono"> de_para_geral_produtos_2026_05.xlsx</span>.
            </div>
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                dragActive
                  ? 'border-[#730401] bg-[#730401]/5'
                  : 'border-gray-200 hover:border-[#730401]/40 hover:bg-gray-50'
              }`}
            >
              <input
                type="file"
                id="file-upload"
                accept=".xlsx"
                onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                className="hidden"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <div className="flex flex-col items-center">
                  <div className="w-14 h-14 bg-[#730401]/10 rounded-full flex items-center justify-center mb-4">
                    <Upload className="w-7 h-7 text-[#730401]" />
                  </div>
                  <p className="text-gray-700 font-medium mb-1">
                    Clique ou arraste o arquivo aqui
                  </p>
                  <p className="text-sm text-gray-400">Apenas .xlsx (máx. 50MB)</p>
                </div>
              </label>
            </div>

            {file && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <FileSpreadsheet className="w-5 h-5 text-[#730401]" />
                  <div>
                    <p className="text-sm text-gray-900 font-medium">{file.name}</p>
                    <p className="text-xs text-gray-400">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {isNewTable && (
                    <button
                      type="button"
                      onClick={() => runPreview()}
                      disabled={isPreviewing}
                      className="text-sm text-[#730401] hover:underline font-medium flex items-center gap-1"
                    >
                      {isPreviewing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Pencil className="w-3.5 h-3.5" />
                      )}
                      Reanalisar
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setInferredColumns([]);
                      setShowColumnEditor(false);
                    }}
                    className="text-sm text-[#730401]/80 hover:text-[#730401] font-medium"
                  >
                    Remover
                  </button>
                </div>
              </div>
            )}
          </div>

          {showColumnEditor && inferredColumns.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-[#730401]/20 p-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-1">
                Colunas detectadas — revise os tipos
              </h3>
              <p className="text-xs text-gray-500 mb-4">
                Tipagem inferida a partir das primeiras linhas do arquivo. Os nomes das colunas devem
                coincidir exatamente com o cabeçalho do Excel.
              </p>
              {fileHeaders.length > 0 && (
                <p className="text-xs text-gray-400 mb-3 font-mono">
                  Cabeçalho no arquivo: {fileHeaders.join(', ')}
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                      <th className="pb-2 pr-4">Coluna</th>
                      <th className="pb-2 pr-4">Tipo</th>
                      <th className="pb-2 w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {inferredColumns.map((col, index) => (
                      <tr
                        key={index}
                        className={`border-b border-gray-50 ${columnMismatch(col.name) ? 'bg-[#730401]/5' : ''}`}
                      >
                        <td className="py-2 pr-4">
                          <input
                            value={col.name}
                            onChange={(e) => updateColumn(index, 'name', e.target.value)}
                            className={`w-full px-2 py-1.5 border rounded text-gray-900 font-mono text-xs ${
                              columnMismatch(col.name)
                                ? 'border-[#730401]/50 bg-[#730401]/5'
                                : 'border-gray-200'
                            }`}
                          />
                          {columnMismatch(col.name) && (
                            <p className="text-[10px] text-[#730401] mt-0.5">
                              Não existe no arquivo
                            </p>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <select
                            value={col.type}
                            onChange={(e) => updateColumn(index, 'type', e.target.value)}
                            className="w-full px-2 py-1.5 border border-gray-200 rounded text-gray-900 text-xs"
                          >
                            {COLUMN_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2">
                          <button
                            type="button"
                            onClick={() => removeColumn(index)}
                            className="text-[#730401]/70 hover:text-[#730401] text-xs"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 text-[#730401] flex-shrink-0 mt-0.5" />
              <p className="text-sm text-[#730401]">{error}</p>
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-start space-x-2">
              <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-700">{success}</p>
            </div>
          )}

          <button
            onClick={handleUpload}
            disabled={!canSubmit || isUploading || isPreviewing}
            className="w-full py-3 px-4 bg-[#730401] text-white font-medium rounded-lg hover:bg-[#5f0301] focus:outline-none focus:ring-2 focus:ring-[#730401]/40 focus:ring-offset-2 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Processando...
              </>
            ) : isNewTable ? (
              'Cadastrar tabela e iniciar ingestão'
            ) : (
              'Iniciar ingestão'
            )}
          </button>
        </div>

        <div className="lg:col-span-1">
          {execution && <ExecutionStatus executionId={execution.id} />}
        </div>
      </div>
    </div>
  );
}
