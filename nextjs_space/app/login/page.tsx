'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { APP_BRAND_NAME } from '@/lib/app-config';

function LoginContent() {
  const searchParams = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    const callbackUrl = searchParams.get('callbackUrl') || '/';

    signIn('cognito', { callbackUrl }).catch(() => {
      setError('Erro ao redirecionar para o Cognito');
    });
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm text-center">
        <span
          className="text-[#730401] font-bold text-4xl italic tracking-tight"
          style={{ fontFamily: 'Georgia, serif' }}
        >
          {APP_BRAND_NAME}
        </span>
        <div className="mt-8 flex items-center justify-center gap-3 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin text-[#730401]" />
          <span className="text-sm font-medium">Redirecionando para login seguro...</span>
        </div>
        {error && (
          <div className="mt-6 p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg">
            <p className="text-sm text-[#730401]">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
