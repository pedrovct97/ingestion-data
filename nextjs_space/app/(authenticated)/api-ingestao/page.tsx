'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import {
  Activity,
  Play,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Circle,
  Ban,
  EyeOff,
  RotateCcw,
  Download,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type TrafficLight = 'success' | 'partial' | 'error' | 'aborted' | 'running' | 'idle' | 'ignored';

interface TableStatus {
  tableId: string;
  displayName: string;
  status: TrafficLight;
  statusLabel: string;
  ignored?: boolean;
  ignoredAt?: string;
  executionArn?: string;
  executionName?: string;
  startDate?: string;
  stopDate?: string;
  message?: string;
  datasetName?: string;
  period?: string;
}

interface TransformationStatus {
  name: string;
  status: TrafficLight;
  statusLabel: string;
  message?: string;
  startDate?: string;
  stopDate?: string;
}

interface CatalogItem {
  tableId: string;
  displayName?: string;
  datasetName?: string;
  ignoredAt?: string;
  reason?: string;
}

interface Catalog {
  active: CatalogItem[];
  ignored: CatalogItem[];
}

const statusStyles: Record<
  TrafficLight,
  { dot: string; bg: string; text: string; icon: typeof CheckCircle2 }
> = {
  success: {
    dot: 'bg-green-500',
    bg: 'bg-green-50 border-green-200',
    text: 'text-green-700',
    icon: CheckCircle2,
  },
  partial: {
    dot: 'bg-amber-400',
    bg: 'bg-amber-50 border-amber-200',
    text: 'text-amber-800',
    icon: AlertTriangle,
  },
  error: {
    dot: 'bg-[#730401]/50',
    bg: 'bg-[#730401]/5 border-[#730401]/20',
    text: 'text-[#730401]',
    icon: AlertCircle,
  },
  aborted: {
    dot: 'bg-orange-500',
    bg: 'bg-orange-50 border-orange-200',
    text: 'text-orange-700',
    icon: AlertTriangle,
  },
  running: {
    dot: 'bg-blue-500 animate-pulse',
    bg: 'bg-blue-50 border-blue-200',
    text: 'text-blue-700',
    icon: Loader2,
  },
  idle: {
    dot: 'bg-gray-300',
    bg: 'bg-gray-50 border-gray-200',
    text: 'text-gray-500',
    icon: Circle,
  },
  ignored: {
    dot: 'bg-slate-400',
    bg: 'bg-slate-50 border-slate-300',
    text: 'text-slate-600',
    icon: Ban,
  },
};

// Periodo padrao para reprocessamento manual na tela.
function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Card de uma tabela/API do BLOCO 1. Ele nao calcula regra de negocio; apenas
// renderiza o status ja consolidado pelo backend.
function TableCard({ table }: { table: TableStatus }) {
  const style = statusStyles[table.status] || statusStyles.idle;
  const Icon = style.icon;

  return (
    <div
      className={`rounded-xl border p-5 ${style.bg} transition-shadow hover:shadow-md`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="font-semibold text-gray-900 font-mono text-sm">{table.tableId}</p>
          {table.displayName !== table.tableId && (
            <p className="text-xs text-gray-500 mt-0.5">{table.displayName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${style.dot}`} title={table.statusLabel} />
          <Icon
            className={`w-5 h-5 ${style.text} ${table.status === 'running' ? 'animate-spin' : ''}`}
          />
        </div>
      </div>
      <p className={`text-sm font-medium ${style.text}`}>{table.statusLabel}</p>
      {table.message && (
        <p className="text-xs text-gray-600 mt-2 line-clamp-2">{table.message}</p>
      )}
      {table.ignoredAt && (
        <p className="text-xs text-gray-400 mt-2">
          Ignorada desde {new Date(table.ignoredAt).toLocaleString('pt-BR')}
        </p>
      )}
      {table.startDate && !table.ignored && (
        <p className="text-xs text-gray-400 mt-2">
          {new Date(table.startDate).toLocaleString('pt-BR')}
        </p>
      )}
    </div>
  );
}

// Card separado para o BLOCO 2 de transformacoes Glue. Separar visualmente evita
// o usuario interpretar erro de transformacao como erro de extracao da API.
function TransformationCard({ item }: { item: TransformationStatus }) {
  const style = statusStyles[item.status] || statusStyles.idle;
  const Icon = style.icon;

  return (
    <div className={`rounded-lg border p-4 ${style.bg}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900 text-sm">{item.name}</p>
          <p className={`text-sm font-medium mt-1 ${style.text}`}>{item.statusLabel}</p>
        </div>
        <Icon
          className={`w-5 h-5 ${style.text} ${item.status === 'running' ? 'animate-spin' : ''}`}
        />
      </div>
      {item.message && (
        <p className="text-xs text-gray-600 mt-2 line-clamp-2">{item.message}</p>
      )}
      {item.startDate && (
        <p className="text-xs text-gray-400 mt-2">
          {new Date(item.startDate).toLocaleString('pt-BR')}
        </p>
      )}
    </div>
  );
}

// Tela operacional da ingestao API.
// Ela dispara reprocessamento por dataset/period e consulta o semaforo a cada 5s.
export default function ApiIngestaoPage() {
  const { data: session, update: updateSession } = useSession();
  const canRunApiActions = Boolean((session?.user as any)?.permissions?.canRunApiActions);
  const [datasetName, setDatasetName] = useState('SAP');
  const [period, setPeriod] = useState(currentPeriod());
  const [appliedDatasetName, setAppliedDatasetName] = useState('SAP');
  const [appliedPeriod, setAppliedPeriod] = useState(currentPeriod());
  const [tables, setTables] = useState<TableStatus[]>([]);
  const [ignoredTables, setIgnoredTables] = useState<TableStatus[]>([]);
  const [transformations, setTransformations] = useState<TransformationStatus[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({ active: [], ignored: [] });
  const [lastMaster, setLastMaster] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTriggering, setIsTriggering] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [isDownloadingExport, setIsDownloadingExport] = useState(false);
  const [ignoreDialogOpen, setIgnoreDialogOpen] = useState(false);
  const [ignoreLoading, setIgnoreLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const statusRequestIdRef = useRef(0);
  const statusAbortRef = useRef<AbortController | null>(null);
  const sessionUpdateRequestedRef = useRef(false);

  useEffect(() => {
    if (sessionUpdateRequestedRef.current) return;
    sessionUpdateRequestedRef.current = true;
    updateSession();
  }, [updateSession]);

  // Busca status consolidado no backend. O backend ja fixa a execucao atual pelo
  // executionArn salvo no historico, entao a tela apenas reflete o retorno.
  const fetchStatus = useCallback(async (filters?: { datasetName?: string; period?: string }) => {
    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    const requestId = statusRequestIdRef.current + 1;
    statusRequestIdRef.current = requestId;
    const requestDatasetName = filters?.datasetName ?? appliedDatasetName;
    const requestPeriod = filters?.period ?? appliedPeriod;

    try {
      const params = new URLSearchParams();
      if (requestDatasetName) params.append('dataset_name', requestDatasetName);
      if (requestPeriod) params.append('period', requestPeriod);

      const response = await fetch(`/excel_ingestion/api-ingestion?${params}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao carregar status');
      if (statusRequestIdRef.current !== requestId) return;

      setTables(data.tables || []);
      setIgnoredTables(data.ignoredTables || []);
      setTransformations(data.transformationStatuses || []);
      if (data.catalog) setCatalog(data.catalog);
      setLastMaster(data.lastMasterExecution);
      setError('');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (statusRequestIdRef.current !== requestId) return;
      setError(err?.message || 'Erro ao carregar monitoramento');
    } finally {
      if (statusRequestIdRef.current === requestId) {
        setIsLoading(false);
        statusAbortRef.current = null;
      }
    }
  }, [appliedDatasetName, appliedPeriod]);

  // Carrega catalogo ativo/ignorado para o dialogo de APIs descontinuadas.
  const fetchCatalog = useCallback(async () => {
    const response = await fetch('/excel_ingestion/api-ingestion/ignore');
    const data = await response.json();
    if (response.ok && data.catalog) {
      setCatalog(data.catalog);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => {
      clearInterval(interval);
      statusAbortRef.current?.abort();
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (ignoreDialogOpen) fetchCatalog();
  }, [ignoreDialogOpen, fetchCatalog]);

  // Dispara a Step Function master. O backend bloqueia se ja houver execucao
  // RUNNING para evitar concorrencia e confusao no semaforo.
  const handleReprocess = async () => {
    if (!canRunApiActions) return;
    setIsTriggering(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/excel_ingestion/api-ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_name: datasetName, period }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao disparar reprocessamento');
      setSuccess(data.message || 'Reprocessamento iniciado');
      setAppliedDatasetName(datasetName);
      setAppliedPeriod(period);
      fetchStatus({ datasetName, period });
    } catch (err: any) {
      setError(err?.message || 'Erro ao disparar ingestão');
    } finally {
      setIsTriggering(false);
    }
  };

  // Dispara somente a Step Function de transformacao. O payload usa o mesmo
  // contrato da ingestao master: { dataset_name, period }.
  const handleRunTransformations = async () => {
    if (!canRunApiActions) return;
    setIsTransforming(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/excel_ingestion/api-ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_name: datasetName, period, mode: 'transformation' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao disparar transformações');
      setSuccess(data.message || 'Transformações iniciadas');
      setAppliedDatasetName(datasetName);
      setAppliedPeriod(period);
      fetchStatus({ datasetName, period });
    } catch (err: any) {
      setError(err?.message || 'Erro ao disparar transformações');
    } finally {
      setIsTransforming(false);
    }
  };

  // Marca uma API como ignorada no DynamoDB de controle.
  const handleIgnore = async (tableId: string) => {
    setIgnoreLoading(tableId);
    setError('');
    try {
      const response = await fetch('/excel_ingestion/api-ingestion/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_name: datasetName, table_id: tableId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao ignorar tabela');
      setSuccess(data.message);
      if (data.catalog) setCatalog(data.catalog);
      await fetchStatus();
    } catch (err: any) {
      setError(err?.message || 'Erro ao ignorar tabela');
    } finally {
      setIgnoreLoading(null);
    }
  };

  const handleUnignore = async (tableId: string) => {
    setIgnoreLoading(tableId);
    setError('');
    try {
      const response = await fetch(
        `/excel_ingestion/api-ingestion/ignore?dataset_name=${encodeURIComponent(datasetName)}&table_id=${encodeURIComponent(tableId)}`,
        { method: 'DELETE' }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao reativar tabela');
      setSuccess(data.message);
      if (data.catalog) setCatalog(data.catalog);
      await fetchStatus();
    } catch (err: any) {
      setError(err?.message || 'Erro ao reativar tabela');
    } finally {
      setIgnoreLoading(null);
    }
  };

  const handleDownloadExport = async () => {
    setIsDownloadingExport(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.append('period', period);

      const response = await fetch(`/excel_ingestion/api-ingestion/export-download?${params}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Arquivo não disponível para o período selecionado');
      }

      const blob = await response.blob();
      const encodedFileName = response.headers.get('X-File-Name');
      const disposition = response.headers.get('Content-Disposition') || '';
      const fileName =
        (encodedFileName ? decodeURIComponent(encodedFileName) : null) ||
        disposition.match(/filename="([^"]+)"/)?.[1] ||
        `prd-lucro_bruto_${period}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSuccess(`Arquivo baixado: ${fileName}`);
    } catch (err: any) {
      setError(err?.message || 'Erro ao baixar arquivo');
    } finally {
      setIsDownloadingExport(false);
    }
  };

  const counts = tables.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[#730401] mb-1">Ingestão API</h1>
          <p className="text-gray-500">
            Monitoramento, reprocessamento e gestão de tabelas ignoradas na fila.
          </p>
        </div>

        <Dialog open={ignoreDialogOpen} onOpenChange={setIgnoreDialogOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2.5 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"
            >
              <EyeOff className="w-4 h-4" />
              Ignorar tabela no processamento API
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Gestão de tabelas ignoradas</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-gray-500 -mt-2">
              Tabelas cadastradas na tabela de ignore são puladas pela Step Function na fila de atualização.
            </p>

            <div className="mt-4 space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                  Em uso ({catalog.active.length})
                </h3>
                {catalog.active.length === 0 ? (
                  <p className="text-sm text-gray-400 py-2">Nenhuma tabela ativa no DynamoDB raw.</p>
                ) : (
                  <ul className="space-y-1 max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                    {catalog.active.map((t) => (
                      <li
                        key={t.tableId}
                        className="flex items-center justify-between px-3 py-2 hover:bg-gray-50"
                      >
                        <span className="font-mono text-sm text-gray-800">{t.tableId}</span>
                        <button
                          type="button"
                          disabled={ignoreLoading === t.tableId}
                          onClick={() => handleIgnore(t.tableId)}
                          className="text-xs text-slate-600 hover:text-[#730401] flex items-center gap-1 disabled:opacity-50"
                        >
                          {ignoreLoading === t.tableId ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Ban className="w-3 h-3" />
                          )}
                          Ignorar
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                  <Ban className="w-3.5 h-3.5 text-slate-500" />
                  Ignoradas no processamento ({catalog.ignored.length})
                </h3>
                {catalog.ignored.length === 0 ? (
                  <p className="text-sm text-gray-400 py-2">Nenhuma tabela ignorada.</p>
                ) : (
                  <ul className="space-y-1 max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100 bg-slate-50/50">
                    {catalog.ignored.map((t) => (
                      <li
                        key={t.tableId}
                        className="flex items-center justify-between px-3 py-2"
                      >
                        <span className="font-mono text-sm text-slate-600">{t.tableId}</span>
                        <button
                          type="button"
                          disabled={ignoreLoading === t.tableId}
                          onClick={() => handleUnignore(t.tableId)}
                          className="text-xs text-[#730401] hover:underline flex items-center gap-1 disabled:opacity-50"
                        >
                          {ignoreLoading === t.tableId ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3 h-3" />
                          )}
                          Reativar
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Parâmetros da execução</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">dataset_name</label>
            <input
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
              placeholder="SAP"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">
              period (YYYY-MM)
            </label>
            <input
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              pattern="\d{4}-\d{2}"
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
              placeholder="2025-05"
            />
          </div>
          <div className="flex flex-wrap items-end gap-2 md:col-span-2">
            <button
              onClick={() => {
                setIsLoading(true);
                setAppliedDatasetName(datasetName);
                setAppliedPeriod(period);
                fetchStatus({ datasetName, period });
              }}
              className="min-w-[140px] flex-1 py-2.5 px-4 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Atualizar
            </button>
            <button
              onClick={handleReprocess}
              disabled={!canRunApiActions || isTriggering || isTransforming || !period}
              title={!canRunApiActions ? 'Sua role não permite reprocessamento pela aba API' : undefined}
              className={`min-w-[140px] flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 ${
                canRunApiActions
                  ? 'bg-[#730401] text-white hover:bg-[#5f0301] disabled:opacity-50'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isTriggering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Reprocessar
            </button>
            <button
              onClick={handleRunTransformations}
              disabled={!canRunApiActions || isTransforming || isTriggering || !period}
              title={!canRunApiActions ? 'Sua role não permite executar transformações pela aba API' : undefined}
              className={`w-full sm:w-auto sm:min-w-[190px] py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 whitespace-nowrap ${
                canRunApiActions
                  ? 'bg-[#730401] text-white hover:bg-[#5f0301] disabled:opacity-50'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isTransforming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Somente transformações
            </button>
          </div>
        </div>

        <div className="mt-4 p-3 bg-gray-50 rounded-lg text-xs leading-relaxed text-gray-600">
          Se houver ingestão manual de arquivos necessários para processamento, execute o reprocessamento completo após a importação.
          Execute somente as transformações quando a atualização das tabelas já tiver
          concluído e apenas a fase de transformação falhar, ou após importar um
          arquivo manual usado para correção de dados.
        </div>

        {error && (
          <div className="mt-4 p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg text-sm text-[#730401]">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {success}
          </div>
        )}

        {lastMaster && (
          <div className="mt-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-500 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Última execução master: <strong>{lastMaster.status}</strong>
            {lastMaster.period && ` · período ${lastMaster.period}`}
            {lastMaster.startDate &&
              ` · ${new Date(lastMaster.startDate).toLocaleString('pt-BR')}`}
          </div>
        )}

        <div className="mt-4 p-4 rounded-lg border border-gray-200 bg-white flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-800">
              Download da extração lucro_bruto
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Informe o período desejado e clique em baixar. A aplicação buscará o arquivo mais recente do período selecionado.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownloadExport}
            disabled={!period || isDownloadingExport}
            className="w-full lg:w-auto py-2.5 px-4 bg-[#730401] text-white rounded-lg hover:bg-[#5f0301] disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap"
          >
            {isDownloadingExport ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            Baixar extração
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {(['success', 'partial', 'error', 'aborted', 'running', 'idle'] as TrafficLight[]).map((s) => (
          <div
            key={s}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${statusStyles[s].bg} ${statusStyles[s].text}`}
          >
            <span className={`w-2.5 h-2.5 rounded-full ${statusStyles[s].dot}`} />
            {counts[s] || 0}{' '}
            {s === 'success'
              ? 'OK'
              : s === 'partial'
                ? 'Parcial'
                : s === 'error'
                  ? 'Erro'
                  : s === 'aborted'
                    ? 'Abortada'
                  : s === 'running'
                    ? 'Rodando'
                    : 'Idle'}
          </div>
        ))}
        {ignoredTables.length > 0 && (
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${statusStyles.ignored.bg} ${statusStyles.ignored.text}`}
          >
            <span className={`w-2.5 h-2.5 rounded-full ${statusStyles.ignored.dot}`} />
            {ignoredTables.length} Ignoradas
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 text-[#730401] animate-spin" />
        </div>
      ) : tables.length === 0 && ignoredTables.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
          Nenhum table_id encontrado no DynamoDB. Verifique credenciais AWS ou execute um
          reprocessamento.
        </div>
      ) : (
        <div className="space-y-8">
          {tables.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                Tabelas em processamento ({tables.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tables.map((table) => (
                  <TableCard key={table.tableId} table={table} />
                ))}
              </div>
            </section>
          )}

          {ignoredTables.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-600 mb-3 flex items-center gap-2">
                <Ban className="w-4 h-4" />
                Tabelas ignoradas — não entram na fila API ({ignoredTables.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {ignoredTables.map((table) => (
                  <TableCard key={`ignored-${table.tableId}`} table={table} />
                ))}
              </div>
            </section>
          )}

          {transformations.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-500" />
                Transformações Glue ({transformations.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {transformations.map((item) => (
                  <TransformationCard key={`${item.name}-${item.startDate || ''}`} item={item} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="text-xs text-gray-400 border-t border-gray-100 pt-4">
        <p>
          <strong>Verde:</strong> concluído · <strong>Amarelo:</strong> parcial ·{' '}
          <strong>Vermelho:</strong> erro · <strong>Cinza:</strong> ignorada (descontinuada)
        </p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed">
          Configure SFN, Raw e Ignore via variáveis de ambiente.
        </p>
      </div>
    </div>
  );
}
