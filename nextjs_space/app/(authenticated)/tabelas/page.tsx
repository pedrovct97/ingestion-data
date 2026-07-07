'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Cloud, Database, Loader2, Pencil, Save, Upload, X } from 'lucide-react';

interface Column {
  name: string;
  type: string;
}

interface TableItem {
  id?: string;
  tableName: string;
  displayName: string;
  description?: string | null;
  requiredColumns: (string | Column)[];
  s3Prefix?: string;
  manualIngestionEnabled?: boolean;
}

const ATHENA_COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date'];

function normalizeColumns(columns: TableItem['requiredColumns']) {
  return (columns || []).map((col: any) => ({
    name: String(typeof col === 'string' ? col : col.name || '').trim(),
    type: String(typeof col === 'string' ? 'string' : col.type || 'string').trim().toLowerCase(),
  }));
}

export default function TabelasPage() {
  const [tables, setTables] = useState<TableItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editTable, setEditTable] = useState<TableItem | null>(null);
  const [editColumns, setEditColumns] = useState<Column[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [toggleLoadingId, setToggleLoadingId] = useState<string | null>(null);

  const loadTables = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/excel_ingestion/tables?sourceType=file');
      const data = await response.json();
      setTables(data.tables || []);
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar tabelas');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTables();
  }, []);

  const openEdit = (table: TableItem) => {
    if (!table.id) {
      setError('Essa tabela ainda não possui schema salvo. Faça um Upload primeiro para inferir colunas.');
      return;
    }
    setError('');
    setSuccess('');
    setEditTable(table);
    setEditColumns(normalizeColumns(table.requiredColumns));
  };

  const closeEdit = () => {
    setEditTable(null);
    setEditColumns([]);
  };

  const saveEdit = async () => {
    if (!editTable?.id) return;
    setError('');
    setSuccess('');

    if (editColumns.length === 0) {
      setError('Defina pelo menos uma coluna.');
      return;
    }

    const invalidColumns = editColumns.filter((column) => !ATHENA_COLUMN_TYPES.includes(column.type));
    if (invalidColumns.length > 0) {
      const invalidList = invalidColumns
        .map((column) => `${column.name || '(sem nome)'} (${column.type || 'sem tipo'})`)
        .join(', ');
      setError(`Tipos inválidos para Athena: ${invalidList}. Tipos permitidos: ${ATHENA_COLUMN_TYPES.join(', ')}.`);
      return;
    }

    const columnsChanged = JSON.stringify(normalizeColumns(editTable.requiredColumns)) !== JSON.stringify(editColumns);
    if (columnsChanged) {
      const confirmed = window.confirm(
        'Você tem certeza que deseja editar os tipos das colunas? Esse processo pode acarretar em problemas internos no Banco de Dados.'
      );
      if (!confirmed) return;
    }

    setIsSaving(true);
    try {
      const response = await fetch('/excel_ingestion/tables', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editTable.id,
          tableName: editTable.tableName,
          columns: editColumns,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao atualizar tabela');
      }
      setSuccess('Tipos das colunas atualizados com sucesso.');
      closeEdit();
      await loadTables();
    } catch (err: any) {
      setError(err?.message || 'Erro ao atualizar tabela');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleManualIngestion = async (table: TableItem) => {
    if (!table.id) {
      setError('Essa tabela ainda não possui cadastro salvo para edição.');
      return;
    }

    setToggleLoadingId(table.id);
    setError('');
    setSuccess('');
    try {
      const nextValue = table.manualIngestionEnabled === false;
      const response = await fetch('/excel_ingestion/tables', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: table.id,
          tableName: table.tableName,
          manualIngestionEnabled: nextValue,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erro ao atualizar ingestão manual');
      }
      setSuccess(
        nextValue
          ? 'Tabela liberada para ingestão manual.'
          : 'Tabela removida da lista de ingestão manual.'
      );
      await loadTables();
    } catch (err: any) {
      setError(err?.message || 'Erro ao atualizar ingestão manual');
    } finally {
      setToggleLoadingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#730401] mb-1">Edição de Tabelas</h1>
        <p className="text-gray-500">Aqui você pode bloquear ingestão manual e editar somente os tipos das colunas.</p>
      </div>

      {error && !editTable && (
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

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center space-x-3 mb-5">
          <Database className="w-6 h-6 text-[#730401]" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Tabelas Configuradas</h3>
            <p className="text-sm text-gray-500">Informações operacionais cadastradas no DynamoDB</p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 text-[#730401] animate-spin" />
          </div>
        ) : tables.length === 0 ? (
          <p className="text-center text-gray-400 py-8">Nenhuma tabela encontrada</p>
        ) : (
          <div className="space-y-3">
            {tables.map((table) => (
              <div key={table.tableName} className="p-4 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-gray-900">{table.tableName}</p>
                    <p className="text-sm text-gray-500">{table.description || table.displayName}</p>
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600">
                      <Upload className="w-3.5 h-3.5" />
                      {table.manualIngestionEnabled === false
                        ? 'Ingestão manual bloqueada'
                        : 'Ingestão manual liberada'}
                    </div>
                    {table.s3Prefix && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-gray-400">
                        <Cloud className="w-3.5 h-3.5" />
                        <span className="font-mono">{table.s3Prefix}</span>
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(table.requiredColumns || []).slice(0, 10).map((col: any, index: number) => {
                        const name = typeof col === 'string' ? col : col.name;
                        const type = typeof col === 'object' ? col.type : null;
                        return (
                          <span
                            key={`${table.tableName}-${name}-${index}`}
                            className="px-2 py-0.5 bg-[#730401]/5 border border-[#730401]/15 text-[#730401] text-[11px] font-medium rounded"
                          >
                            {name}{type ? ` (${type})` : ''}
                          </span>
                        );
                      })}
                      {(table.requiredColumns || []).length > 10 && (
                        <span className="px-2 py-0.5 bg-gray-100 border border-gray-200 text-gray-500 text-[11px] font-medium rounded">
                          +{table.requiredColumns.length - 10} colunas
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleManualIngestion(table)}
                      disabled={!table.id || toggleLoadingId === table.id}
                      className={`inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg border transition-all disabled:opacity-50 ${
                        table.manualIngestionEnabled === false
                          ? 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100'
                          : 'border-[#730401]/20 bg-[#730401]/5 text-[#730401] hover:bg-[#730401]/10'
                      }`}
                    >
                      {toggleLoadingId === table.id ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      {table.manualIngestionEnabled === false ? 'Liberar manual' : 'Bloquear manual'}
                    </button>
                    <button
                      onClick={() => openEdit(table)}
                      className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-[#730401] text-white hover:bg-[#5f0301] transition-all"
                    >
                      <Pencil className="w-4 h-4 mr-2" />
                      Editar
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={closeEdit} />
          <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-2xl">
            <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Editar tipos das colunas</h3>
                <p className="text-sm text-gray-400 font-mono">{editTable.tableName}</p>
              </div>
              <button onClick={closeEdit} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {error && (
                <div className="p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg flex items-start space-x-2">
                  <AlertCircle className="w-5 h-5 text-[#730401] flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-[#730401]">{error}</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Tipos permitidos no Athena
                </label>
                <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50">
                  {editColumns.map((column, index) => (
                    <div
                      key={`${column.name}-${index}`}
                      className="grid grid-cols-[1fr_180px] gap-3 border-b border-gray-200 px-4 py-3 last:border-b-0"
                    >
                      <p className="truncate font-mono text-sm text-gray-900">{column.name}</p>
                      <select
                        value={column.type}
                        onChange={(event) => {
                          const nextColumns = [...editColumns];
                          nextColumns[index] = {
                            ...nextColumns[index],
                            type: event.target.value,
                          };
                          setEditColumns(nextColumns);
                        }}
                        className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:border-[#730401] focus:outline-none focus:ring-2 focus:ring-[#730401]/20"
                      >
                        {ATHENA_COLUMN_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Apenas o tipo pode ser alterado. Os nomes das colunas permanecem iguais ao data_schema do DynamoDB.
                </p>
              </div>
            </div>

            <div className="border-t border-gray-100 px-6 py-4 flex justify-end space-x-3">
              <button onClick={closeEdit} className="px-5 py-2.5 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg">
                Cancelar
              </button>
              <button
                onClick={saveEdit}
                disabled={isSaving}
                className="px-5 py-2.5 text-sm font-medium text-white bg-[#730401] rounded-lg hover:bg-[#5f0301] disabled:opacity-50 inline-flex items-center"
              >
                {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
