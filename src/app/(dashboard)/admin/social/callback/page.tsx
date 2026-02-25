'use client';

/**
 * Meta OAuth Callback Page
 * Handles the OAuth redirect and posts the code back to the parent window
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

export default function MetaOAuthCallback() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (error) {
      setStatus('error');
      setErrorMessage(errorDescription || error);
      return;
    }

    if (code) {
      // Post the code back to the parent window
      if (window.opener) {
        window.opener.postMessage(
          { type: 'meta-oauth-callback', code },
          window.location.origin
        );
        setStatus('success');
        // Close after a short delay to show success
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        setStatus('error');
        setErrorMessage('Unable to communicate with parent window. Please close this window and try again.');
      }
    } else {
      setStatus('error');
      setErrorMessage('No authorization code received.');
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center p-8 bg-white rounded-lg shadow-lg max-w-md">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900">Connecting...</h2>
            <p className="text-sm text-gray-600 mt-2">Please wait while we complete the connection.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900">Connected!</h2>
            <p className="text-sm text-gray-600 mt-2">This window will close automatically.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900">Connection Failed</h2>
            <p className="text-sm text-gray-600 mt-2">{errorMessage}</p>
            <button
              onClick={() => window.close()}
              className="mt-4 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700"
            >
              Close Window
            </button>
          </>
        )}
      </div>
    </div>
  );
}
