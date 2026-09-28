import {lazy, StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';

const publicTestPage = window.location.pathname === '/test' || window.location.pathname.startsWith('/test/');
const publicAdminPage = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
const PublicTestApp = lazy(() => import('./PublicTestApp'));
const PublicAdminApp = lazy(() => import('./PublicAdminApp'));
const AutoVideoApp = lazy(() => import('./AutoVideoEntry'));
const App = publicAdminPage ? PublicAdminApp : publicTestPage ? PublicTestApp : AutoVideoApp;
if (publicTestPage) document.title = '洗车短视频内测';
if (publicAdminPage) document.title = '公网测试 · 管理员监控';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}><App /></Suspense>
  </StrictMode>,
);
