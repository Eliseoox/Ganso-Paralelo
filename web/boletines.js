    'use strict';

    // ── Constantes académicas (modificar para cambiar criterios) ────────────────
    // Estos rangos convierten el promedio numérico interno a trayectoria visible
    const TEA_MIN_DEFAULT = 7.0;  // >= TEA_MIN → TEA (Trayectoria Educativa Avanzada)
    const TEP_MIN_DEFAULT = 4.0;  // >= TEP_MIN y < TEA_MIN → TEP (en Proceso)
    // promedio < TEP_MIN → TED (Trayectoria Educativa Discontinua)

    const FIXED_COURSES  = ["1ero","2do","3ero","4to","5to","6to"];
    const GRADE_COLS_DEF = ["Nota 1","Nota 2","Nota 3","Nota 4","Nota 5","Nota 6"];
    const SESS_KEY       = 'app_institution';

    let institutionId    = '';
    let institutionName  = '';
    let allSubjectData   = [];
    let logoBase64       = null;
    let toastTimer       = 0;
    let _refreshInFlight = false;

    // ── Utilidades ─────────────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }

    function showToast(msg, dur = 3500) {
        const t = $('toast');
        clearTimeout(toastTimer);
        t.textContent = msg;
        t.classList.add('visible');
        toastTimer = setTimeout(() => t.classList.remove('visible'), dur);
    }

    function escHtml(v) {
        return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function getTeaMin() { return parseFloat($('teaMin')?.value ?? TEA_MIN_DEFAULT) || TEA_MIN_DEFAULT; }
    function getTepMin() { return parseFloat($('tepMin')?.value ?? TEP_MIN_DEFAULT) || TEP_MIN_DEFAULT; }

    function trajectoryDescription(t) {
        return { TEA: 'Trayectoria Educativa Avanzada', TEP: 'Trayectoria Educativa en Proceso', TED: 'Trayectoria Educativa Discontinua' }[t] || '';
    }

    function computeAvg(grades, cols) {
        return Utils.calculateAverage(cols.map(c => grades?.[c]));
    }

    function getSessionInst() {
        try { const r = sessionStorage.getItem(SESS_KEY); return r ? JSON.parse(r) : null; } catch(_) { return null; }
    }

    function getConfig() {
        return {
            periodo:      ($('periodoInput')?.value || '').trim(),
            schoolYear:   ($('schoolYear')?.value   || String(new Date().getFullYear())).trim(),
            directorName: ($('directorName')?.value || '').trim(),
            directorTitle:($('directorTitle')?.value|| '').trim(),
            instNote:     ($('institutionalNote')?.value || '').trim(),
        };
    }

    // ── Carga del logo (fetch, compatible con web/Electron/APK) ────────────────
    async function preloadLogo() {
        // Incrustado directo como data URI (antes se pedía por fetch() a
        // logos/web-app-manifest-192x192.png — en algunas PCs ese archivo
        // puntual puede fallar con EPERM al abrirse desde disco; incrustarlo
        // evita depender de esa lectura en tiempo de ejecución).
        logoBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAAQHRFWHRTb2Z0d2FyZQBSZWFsRmF2aWNvbkdlbmVyYXRvciAoaHR0cHM6Ly9yZWFsZmF2aWNvbmdlbmVyYXRvci5uZXQpmZlW4QAAEABJREFUeAHsvQmcHVd95/s9tdx7+/beLbWsXdZqybJlDNjYeAE7gDFgs9rAS5yEx0syyYcJQ0KYJMAEZnjzPu9NXublzRBCGDIGDAaH3WYJi40B4x2vkmzL2tWSel/ufqvqzO/cVjeyvLVBkvu2qlT/qjrb//zP7/x/p845ddv27M53Wfukk3fqfpTseLe1Tyj+cSeKf/yIPKa7k+3XWitJtl1jG7JV4a1Kc/LotTY5IvYRxT0iHQ/rLkkeUpokfvAaax9U3BFJHlD8EbG/vNba+51cY5P7Jfe9w8b3vsPae5X/HsXfc421dx8tir/7nTa569oZie9U+i8kd0yLyv/8GPnZ262dlp++zdqfKny78hyR5Pa32+QnU2Jvu8Ymt73DJrdOSXzr223847db+6OjRTp+eER+oPhp+VfFTcv3FH+0fFdpTr6j+4y81dpb3mqTm99i7c1vtfbbSpuWb73VJhL7LaV908lbrf2m5Btvs8nXp8R+TeEjknz1LXZa7L8oflpuUryTr7zZ2i8fIzdeba2TL73F2hlRni8ekRuU/oWj5PNXWdsQxX3+zTb53NVPleuvtvZ/vnlGkn++2k6L/aye/8dVNjlG7Kevtr+Sq6z9xyPyKcU7+QeFj5ZPSv9/V5qT/6a0o+X/V/jv32TtMZL8f2+0HumRInAKI5AS4BTu/LTpkBIg9YJTGoGUAKd096eNP4UJkHZ+ikA6BUp94BRHIH0DnOIOcKo3PyXAqe4Bp3j7UwKc4g5wqjc/JcCp6AFpm2cQSAkwA0X6cCoikBLgVOz1tM0zCKQEmIEifTgVEUgJcCr2etrmGQRSAsxAkT6cCggc28aUAMcikoZPKQRSApxS3Z029lgEUgIci0gaPqUQSAlwSnV32thjEUgJcCwiafiUQuAUIsAp1a9pY2eJQEqAWQKVZpufCKQEmJ/9mrZqlgikBJglUGm2+YlASoD52a9pq2aJQEqAWQLV1NlS458VgZQAzwpNmnAqIJAS4FTo5bSNz4pASoBnhSZNOBUQSAlwKvRy2sZnRSAlwLNCkybMBwSerw0pAZ4PoTR9XiOQEmBed2/auOdDICXA8yGUps9rBFICzOvuTRv3fAikBHg+hNL0eY3APCbAvO63tHHHCYGUAMcJyFRNcyKQEqA5+y21+jghkBLgOAGZqmlOBFICNGe/pVYfJwRSAhwnIOeUmtSYWSOQEmDWUKUZ5yMCKQHmY6+mbZo1AikBZg1VmnE+IpASYD72atqmWSOQEmDWUKUZmwGBF2pjSoAXiliaf14hkBJgXnVn2pgXikBKgBeKWJp/XiGQEmBedWfamBeKQEqAF4pYmn9eITCPCDCv+iVtzElCICXASQI6rWZuIpASYBb9YkjAlKkLrcSLMHpOMEwGvQzUe+iX7I0W0p/0UvMyEI+RKC/UAavSgSSExCqcnnMJgUY3zSWD5q4tgVw5wCRy5LiVkWoPX/35QT5x4yP8pxu38jc3bufjX93FNx/Pc8CcTQ3lM76aE4sqqKzRc0oAgTCnzpQAs+gO23DhgDD28OKQaqWFm3++jx9st7T0biS/YBOtfedgu7bwjbvHueneCgOlDJHJo6FfpeuSSDU5EuiWnnMGgZQAs+gKq/HbmhiPGKKE0ZESE1GOcb9HcXV6OlpY3NdDa3s7FTLcvW0v37v3AONJJ9YLVYMrm4A5QXCTHr8uAmmPzAI5YwzWKqMNKQ4VGR4YwU8iVi3tJbNiE/WuxRQzbRTCTkb8bobCPu7pD9g6EFE1OVdQ4gigW3rOKQRSAsymO6xHvZph394i99y9g6hoWN7Wxuq2gFIcUK1DHFtsHOElFs8aDsS93LdjmILSNf9RLYkkPecaAikBjuoRuTDWuKEe3PPU/N1QKVTp3zlC/+4D5FrzWN/Sk6mwvLaHzOhusqO7yIzsIl8YooOETOQmS1kePhixfTAktq1S6AgwpfuoKtPHFxmBlADHdEDD8RXnlqvGNK5MTkzS2ZHjnJes4qUXbmDjS5bz0i0LueJlC/idiwPefVHAOy7McNk5IZ1tE9QzNWySMFT2eXDXhBbDjgBGpJLi9JxTCHhzypo5ZYxzfjdwJ/QtXkjP0hayHTFhW5kwN0EuM0o+O8j6zA7WZZ/kzOxOzmw7zJpFAV4uC16A1TeB4cmSCBCAtkSthPQ4rgj8pspSAjwPgsZzELn3QkSinSCMxdPdN1VCCXEbRHm8mmGxhWWZNtrDXozna+pjiE2gz2EiAJ6+gynD89SXJp9cBFzvntwam622Iz5rrC/LM3LiDFZbnbiwNVQCQy2Ugwcx+WCcvtZJOrIT5FsyuMVvokuifGgbydiE9JhbCKQEmE1/OBLYSLs7Vm8B0xCrER3tDmVsCWss1lMmT98Eun1y2QrtuZBcJsDRZqqKROXjqcf0OmcQSAlwTFcYjdhPiTIWZiRWagLI4RXnHN+PfHx9HSZpUbYsGb9djt6KMtKSU5xncFMmJWKMIT3mFgLe3DLnxbXGoH9uunLEDOfgcnWmokIsnpxbV01nUF6Lj9Vc35pEoap4USG0dYKkjpWzB2GObFYfwrxE2RPFhaTH3EKgiQkwN4A0IkOg6RE2hsZPHTxCfSU2gGcMXmMRTXrMUQRSAhyHjjHO+aUnMi0UNSWKE02bFI71LaBer+spPecqAikBfuOeEYR6C2BCxmln68EC43V9A8ASRVFDfuMqUgUnDAH13gnTfYoodhAafezKsnvccN/ucSb9TrXdUKvVdE/PuYyA6725bN8css1Na44R45bIBvSxq0Irdz12gMFaQF1fgGON/tWaFsPWYJg6LJ62UH29G6ZhP0rfdKZGVhc4IirfiEovJwSB6Z44IcrnlVLnj3Jdt53ZEBI1L8GYKjWT58FDAT/flejDWAchE1SqFfenA6BvBYHWAmiaZHHk8Ii9hjKlTREgUTAxetZuEnrGXfShzUgazxxzpMHjhkBKgFlDKQd9Sl5BJ+dGX3cn4yw/uG8Hk3EL1uoLcN1SrlbxtTiWu8udE5WsK1wkG48TxEU5fwTG19QpQ83Lik7ShxMxwFXlyEB6nGgEHOInuo75pb/h9A42J76mO63cs3OUx0d8irZNbQ2oFctycJj6AGYo+y0kXhuJFsqYHNbL61lxeiOIAuRECB9HEhUXXdx1SlycY8NUKL0efwRcLx5/rfNWoznSMiM39fXss7/Uxi+eLDJhekAObus1Kpr7YwxhmKFq8vzykM9dA23cd7iFOwc6uXuwjV8OZjhQbiFGH8psNDWrakx5OHLI8Y2TI8H0dkIQSAkwa1jljI28RldfI7yn6Y7Hg/2GHSMhFdOq78IJOX3s7epdwNIVy1i1ei31lkV88Wf7+ewd4/yPOyZ1H+EzPxvmk7ce4jM/PcRtew3D/gpNhUQEpNtKnOOj+qbvqjE9TwwCKQFmhaucsZFPzikndVcrR431wesnD/UzEbeCydASGJYv6WPF6lX09HQSZluoa0t0b6WDHZVFkiXsqfaybbKDR4u93KU3wefvHOL6XxxmpOI7l28IM8d0vTMRjQdXf+PhFLwc7yZ7x1vhfNTXcLjE03QlI/ePNPpXmfC7+PKjdXaUDTbxydVcvJ59H+KIUFs7xvc094/IaDGct1VCWyCqlDHVMpmkrl2ikEG7mB/u6eL/+lGNW/b1cqDWpnqsYKwRW71O3LRI5WmsEVx8QuNnF9ZitR6xieKSqThj65pKyQ6VTs/ZIZASYBY4ycWQ50ti5H0apbPsGo64fduwnFQOq7l/7MVYr4Y8UFmfCqtRjJXDVrUzVHPrA6RFYfelWI+N8/FJyxfv2suX7hnjvoEOSv5prhSJiYn8gFjfGhLtGsWuLpNVfCg7DAkimeITLyDW94dE+RoK08usEHhqT82qyKmZKXG/98cRIKGaeNyzbR+DUYdG4TyxnC7yksZoL9cWB8zTQKrI+d3vgoyZSnO3OI5J3OgtVy4GrRzyFvKz/jz/dPsIN907yiF6qPhZrLEYE+FR11ZqDV93TwtnJz6K11asJ0IZ0eFpFacRz4lASoDnhOdXifLBIwFDKNRWLuqmTSO+n1TkkDG+5xNrJlKvRRAjYlg8T85uafwkIqpHCnuNeKdI/upuTBHAkFEhD0PRa+dA0sd3HqtpodyvHSSPQtJKzWaV35MkkNRABMDEuqsC96zpj5dEeLorU3rOEgGH6CyznrrZ5MY4Aljt26Nx2KfCK9Z0cuWZbeT9EX35LePFcu44Q2GyLKDkpLoi38zmsizs6yObzeKmQcYYjJkSl8W9BVx8EItYms8bje6RemXS7+HhoTa+8ItxvvzLCg8X+uhnCWN+H4VwIeWgW1us7dQDfV/Q2yPR9MfqTWSNCjvFqcwKgSZCa1btOXGZ5MxoQWpFADTqdzLM687s4qwNvWRwX319iEJKJS1ekzqeJ0KIAWEQsmL5cjZu3Ehvb8+M8xtjGrZOEyC2OREk0NvETXFEImM1uWnnyfoyvr1L0yJtmV7/8wN844Ehbnl0iDv3ldg2UOFA0TCatFDWm6Ps56l5LQ296WV2CKQEmAVOFjmr8TT+V3GHlaMlmn50a/S/bh2sXmA1dakSmxrlapGRWqw3htF0BEcXQt/Q0Z7nzI3r2bBuPblMBl8E8KRXfg5u5FdZYyJMg2QZYk2poiDS26WClxj6C53c0d/Dd/cs4I7RVdwxsphvPBLzqdtG+Oh3C3zk1pjr76uwsxBSzhiwksgDWWBViUnXB8Li6adD6OmxacysEVjSCVed3c3a8BA5UyGRM9fGBkm0ILDS4kS3mXPRoj7OOusslixZTE7To1hbpkljm5OZw+hJPisygPuRXN23+p7gxGOyHrH78BCHxkssW7mcDcu6OWtxhp5MxGOHi3zrgUMMjVlivZfwE6xXlzZZIWLpIT2PQSAlwDGAvLCgJbQFzltc4S3ndNBKEauRtzAyQqKdmWfWlcjxMyzXtOiMM9bTt2ih3gNyUJz8qoTbdHLiyIBLM9r3V7LVeyiOszzwxAif+s4jfO2Ondz30BNUhg6xZWUf5248A4IFRF4WTIQ1jgBA4uuSnsci4B0bkYZfCAKaWGhqlKHARRt7eMUZC8joLVCPIgqFghybhqDDObIx7ppg5MxBYGhra2XDhnWs0Eiusbrx12NTH7asHFait4gfWTJ1SxjFDalOlNi5bQdDTzxGfGgfO/ZNcteTVX547wE+8/mb+ew/38S99z7A+MQkaB1iVPfUmRJgCoenXlMCPBWPFxyymmNjfPLJKFdtbuVlp9UJTZmxsTHcdMg+h0Zjptyzra1NC+RewmyGWr1GuViiUiozPDDI3l27GR4cIFH8ggVdenMs4hUXnMdFl13OuZddwSsufx2vvfSlvPeKTXzs3efxh6/bwIJun8rEKCQhNLZP5fwmfg5LTt2klAC/Yd/7jfm7r+l2gdWZA1oPdNDXFms3qNRwZmuPpYALHxG9CeShGDTKZ+pQRksAABAASURBVEJ6enpY0LuAfD5P3X04k6xcvZqN52zhzJdtYdHpi1m8ZimnrVnCkjWLWbOmh0u0Ffu7F7bxv52X45LNbbzk7GWce9ZKVizug7rRAjqjKjwwCenxdASEzNMj05jZI2CNg1Cjq/bgE70N1vUZfvvsCl3lMWqFCWoGIk3mE432sc0T6zn2ksbdKg6VT/AJ4orWE3UyLTk6Fi2md8UKXvOmK9iyZSMrtE7Ia+cp1HanHweE0rHIH+X13Qd44+JB1rWOkvEjjIEWfQhrjWugj3SaM4ladYyWxNakBHimXnW990zxadwLQsCi1a/c38qJK5y1ejEXbenDlA8rnOBbj4y+0ubsJMZqOmKDqbtck4a4wTpDrI9ZHgn1wjATh/dg6kW0G0rND6nqwdeCdrE/zLmZnbxmSZG1vYb2ZIxcXMDX1+FQO0qh6sGSHrNEICXALIF63mxuOmMjwqRKNi7yW5sMZyyoEVYnMIlza7/xJjAigDdNAGukVqLROSFEa17iep3J8RGqmvMPTRSpeSGYiFY7zOrcYS7sG+PyJQXWhAfJRyPkbAHk/I6Ayohp6CQ9ZolASoBZAvXc2eTEDcezGs9juXKd5cEeXr0+z5JsgawtU/d8ikGHnBWM+wGcRKWYOjwCffcNtHU6Pj5BoQZV08K+kRJGpOqND3Fx92GuPO0wm1sPk6FKpIW3EXGsasQ4kmSJTVbxGebTcaLbkhLgN0TYkExpMIJSTokmQjinjCqsaq/yqrWwsa2fhfaQ3gyTmu2X8UwN34uVa6qsBUI5er1cYHR8UrtHMe1hjdbiblYne7nydMPLeyZY6B3SVGpSjh5ofZvD2oBYdItMhkgESwxY/ZO69JwlAt4s86XZng0BjdrIla3xRYUA93v8xGhEpkPOWmZN7iCvWz7Ka5aOc25+iIxfxXMLVJEAE6uoI4HB/Vp0YFAf0BKrhWyFTe0lrtsccPXSCdaafjK2ptG9lcTL0aI5f2s0ga8dpimJCJQe6k0T2hLpMXsEUgLMHqtnyTkFoZEzeiYRFWJJBBqR3dsh0Py8jQIb20d43eIDmsaMsDncT2s0qlE81NSoFV+L18nRAYLqAKd7/VyzKeADr13FGze0sFBTKJ+yHDzGswajBTW4Og0KYDyLMRZworhGmoLpOSsEHJKzyphmejYEnNM5cekWI0d0AomLkAhi42nqU6fNL3Fmd4GLT89w/mKfvuggnaXdrMwM8aYzAz705g38h995Oe+8ZAVL22v4QQ0VlA6kNxEBEufzqsFXhPTiDgNGIse3TlQX6TFrBKZRnHWBNONvhkCYHGahPcg5rcO8xOzlpfl9XLR8grdtslyyaJS1YT+d0SGylOToseb59jerMC39nAjMYQI8p91NmWiM3g0m0iheojMZo7fez+rWAkuzo7SaqqZCcWNe72kd4JYHXuIrrxvdm7K5TWF0SoCT3E3u/yFgG1+NNbprOzOjL7gZ6vpinCXy20hMXhblJKFmUeoezfsVSM8ThIAQPkGaU7XPiIAXZ7FJQEEfuvy2LJrYk/FCQlvWdL+AZ8pYt0vkJVhf0x/zjGrSyOOEQEqA4wTk09XIeTWLl7eDdoimBE1pIupKGq/WybS0KFrTHuNhtKNv9C0AIj1HoLA12tWXKJCeJwgB7wTpTdVqvo8TLyDR2F6JLKVaTLFaZrxSoVSPMZ6H+9NIYzTMu/8IFgFYX9hNdYsRcZSicHqeKASmkD5R2k9hvQkekfbsy3L8w+MlDo9VODxeZWiiSqEi5w8yDX74xmLcm6IhRwBLbycNgZQAJwjqWKN3qVxlbLxANUo07fGITQar+b4VOTxjCZyoBzw3zDs5Qbakap8dAcH/7Ilpyq+PgJvaZDMBba0tdEjaclromkhrgDq+dn1atcnTmc/S1daK73ma+vz6daUlf30EhPyvXzgt+ewIGBvj/nClLePR05phYUeGnrxPZ85jUWeePklXPiAMwDgCGEN6nHwEmosAmjJowjyF0oy/uAeJ9suNEo1SXTbPzakVh+LcyczhmuxyzUQ0HmzjevTFaLT2ZsQN0dOLUqNsRro9CQ3lLgYdxtXaEOfPnhzb/VaHuKZRP6I9F9Dbnqcl9PTBy70NErcLKtVWkqi87k6fWwhr/WAaz4p296eJpwQnujVq5Cm2SiFPF6O4KbENfcrhgoqlEXYBh5wT/1dR6Gi0VfXJrqnqrCKnz6lyNHTQVIda1Ez2OidJaGwPymwrL3PCNPCuT44WXPNc57hysbK5RBd2os7nqaLgURHKYyXTOozT4cpLFO8IIEMaRaYuzvklx9ok26wm+dbF+9KntQFOFN8oJ3WOWGivaCosmx0BXL1Km4rTgyvjpFHO6VE+l2cqg67aMtUVl26U/xnEumJHC6CcM1dc2YbI+UVZp9EJ00ejflfiKCyUZlXGCbrzGx4nu7hD8WTXedzra/y3bzS/tsY5uTrHOavr7aPCLujSnWiolA2u6U8Vq1hc2RmRPpxIp1zFunjdcXpdvAubOjhR2Dmyvl/hJdLrnOWIuPhpQURATqhCNA733BDV3tAXgdri7LANJ1bYcyI7XHiaKC6v6nT5cIcLSxoOa139TqR45tnD2GRGPD07cT+ndsVp6E30GMu8SPkiPRs9G5DeRnrDLsUrCn27wDQemDpk/9RDU129prL22YxVB1kJcpBGN8z0i0IuHhfhCuveCLvnZxOVaSQ5Z9CD09kQlZWeRj3OWZyeBhGO5FPWmdM5/kzgGR4cG6WLxghulMF1g7vr8Sl6p98ocutG/JRtjZyuDhfn9CjCuvsMOaWncSqhcZ++OFunxcW5dCfu2Yml8XZyutVGNVuRinNXBawTMTyR8yey3Upo1Dt9tTTb4ZBvNpufZq+12l4kVPe7V7ecRp3S6CzXYe7ZBkqbSrcu3NDgmv4Mos6lMbK5ebATp1N3TUtsY1rgS5filMdKj/vjF4tWskc5gyMiyjstTymHUalfiVV4SqZ1qC7lsA39ntwwaIg9qn0yAFfHVDlPPqu2uTY2yqDjV/qNaw9HwsID5cG4NqicbExke+LCEhRmJr9Tk+hiJQ5Tj6TxGybVdaRMguKNUXrzns4Dmtf6acsT9+eBThwR5JyuY9BaoXF3na09R31ptU6OdtTp8kfuVvkTOVJDGg435XxJ43lKB0q3cpREeqwkooXIZIlNSCJnsM4f5Gixws8krox1+VSXPUqc3oZIJ04aU5dQzp0jse4nExk9u7YYWZtInPN54kIgUT7nlCpnZRu6z4jTcyQce77s9CTuHsruUM+h7llJqOdAukTEaTIohGx0uhwBsdmGLcl0XSKLawNNfDQZAWSucWg72DUtUOdMVmHfQMKTB2rsGqgzVtJbXB0u90B+RpL4HB6ps28oYmisri6dIkilHtM/VOHgcEQ1dmViDaoelZqvuBqTpYR6kmFg3LL7UIVdB6sckJ567OFMsHKCsZLP7sFIaWX2DVrGqwGxZ2VgLGe1jBUj9g/X2ady+0dqHByLGS9DIkfCaTExNenrH6kqT8xEOUYFcQ42XLAcGFX5kZgDkoNjCaMVqKltyqQzkUBZcf1K7x+ty3bnvI74MDBRp1/11WOrNrvaXH5PNlr2CYd9YxH7pXOfZM+Y6lLe/ROW/eMxpbpT7eGuWFfOihwZBkuBcIzZPVTG1TcprKzsMa4GN21yolLNdLpWzhF7Z2FGHJJodDVu7hsbDo14fPo7O/no39/H+/7rL3n/Jx/l7774ODv2JOqSFollvN7CJ65/mA/9007+9vMPULNtJBolt/YX+OtPP8TffOYAWwcg8mqYOMNj++DD/3w/P7hnmJ89WuMTX3qcP//UL/l3//1BPv7ZHXzrtn5KUQtb98PfffUAf/2PD/PvP3knH/3Ubv7x20PskTMSZUjqhm//7DAfuf5JPnz9E3zsfz7Ef/78dv7rtx/jzq2x7MhSV53bDsJHP7edD96wi2/+fI98LqZu2vjS7Qf5mxse5qNffJiP3fAQ//HGrfyXW57ku1snVK4DRBzrxfzkQdVxww4+/OWt3LvLglenohZ+8vt7+E9f30//cE35XTeX8SO4besYH/vqdj5+0+N8QmU+ftM2PnbTTv72pof5z9/ey3/42uM8dlCsEsET4UQSi7BwvwaAv/3ebj7ylV/ykRvu5+NffZLP3TnCoZIGFOVxfHZvwFn04pzK4pCZUwY9pzFeSaO0fERTknrUzR33TPKT2w/RKX9412WbOX/FAh5+dJTrb9mp0bQLL25jaDTLbr0dBoZiHttdYXIyp12aPOVyjkOjht0DEQ89Og5JN/gJBf3bNVJh20CWW36+j127BrjgrDW88aKzqOmN8OWfDnDzQzlu/PEB7pf3rl2+iCsv30Jvr88v7jvID+8qUrQLKNlOhsotHNLIf86ZZ/HKLZtYc1o39zzWz7/c9gh7RxKqtLP1QIn9E4bDEz53PzFOOeylqinIeM0wqhF39dLTeeXZa9i4qocD+6t8+Zb9bB9qoxq0y9I27tozwb6iZb/eGI/uU3lNByMbMF6oMjxRoG4NaO6ORupY92I5ZHw44bTOHi7cvIxXndnLa8/s5hUbFyuHZXCyhvv9khGJjMkReS30Vzv4yg8eZm//Yc5YvpArLthMW97y0we38dMnxpjw2qj77u3TXO6EjuayWCO/UedaGV72c9z7yCHaOvv44F9czm+/vp0PXncOp29YxKNDY+wePAAxbNs1TNDaTUdHBxW/nd37xzRYeSSat9dMjqqf4d4H92Ntl0hQ01tDN6+L/SMZdvRPcvkl5/DH157DdW/o4XffdQ6j8STfvHsrT46MsGRZhve/Zwtvf02ev/jTl9HT57N1z0GG6wPYYJgoGMX4A1x56WKufd0i3nvNWi659GKeHKywbccAnsmzY/8E7V09tAY5+seNSAO+iWSjwfeyXHjWQq59TSfXXb2Yyy/eQFEj/+0P30s9LFInJwJNksvnaGtv58mDYyqcx5qMHD9QeoBz+gSN0loLxH5MrMEjjg0bVi3gLZeu5R2XLuWaCxfzpos30dPdoSlWBkcgdBj3/zvzjPSWGSrlWbm8hz+46kLedt4a3ve7r6FFdT64a4xykMWqpGdVqMlOr5nstQTyzgzGVKmYkkbNEZYuz5D3KgTJGDnG2bB6GbVqwqjmz84RHtm9l+6ukC1rOrCaA+w6PCQnqIPIlAnrchw4eGiC/YNFIi8gE+dokYNUiyVqtSIbTm+jrb6LlvoQ5yz36LTjTA5NUB6POHvNOrriIbpqhcZ9zYpFjGkKVK/6ZONENoVktHvUGZdprw7Snoxy7qou4sRQKCfYyLD/wABnLG5jfbeR43kcGhgnV6/KTRNCUyMfT9BeG6OnNs6q7lZacy0MDxQJNF0bGp6kXI/YuChkZU+odoxQrRo5Y4DVgjdRexILxhoUCcIJ9bjRmy70x8hymNZoiFwyTKh6fFEG6wooEzriWNRSiFLaAAAQAElEQVQpMa43Sa1sNfp30B0flD0DtMf9LO/rZExvuCSpqZ2aNrn1goo103mkpc1hcuzF6kgPQ0TiQRxlyYsTucgHm1MHQ6dGxrZ4nFoJ6ibPY3sO0dvuce7pGhk1Su2Wg0WaChh1bdZWWLu0i3ymm5/c9STVsEN+EhAqPjA1rOdpKqG7bZX+NrrMJH923ev4rZefRVAPyJl2OZcH1V4yUY4g41HWQtjWO/HjFpKkS9KtqViLjA1JbI6F4aTePoaiiDY8mWixWmFZl8/GZSG1JKZ/qISvt1ysXaRIhLXGqGwH1NrI+B74dWoVHy/qZb/y1hPD2cvbWdQGxbpH/3BFNnHkSISVxX3wQs7pJ57aEah+JZtI8XL2unBxuJq6hpcagY0aZRKjvF6W2IuoRQlR7JHJRfgafKRE5KyQ9X2qRfBlV5JIp+zWtalOtbJ57E28moxVp2mUSuIAE3XJEfPquHGQY9Wyg5z/shx/9kcXsXlzt9YBdQ4NFeltbeHsVYsI1EkDw2VKGiVNEhJEEWuX9NHZupB7H9rHeORRD6xG4iLtnS1k8r38661bmYwXUM7EWG8X552dsGZ5GT8YhFyRWlgAOUvsV4jzQyLRMHFQI/GLREGFmqQelkgyBSqZsshVJNa0q2ha2TWoOJOhr6dV04suKiLcPo3ukbY9a6aFihyrElalJ5KXRbJtkKhlP2F7ldj47FbeOMhx+uIuejryVINWdupt5onGRuIJKkMsQsWIffhxFqN1DNoOToSaTcSaaAFVf4oUnvsBX1IXARISXWOTk/0BNdUV630RyZ56GIJ2sazakMj2SM+1xBB5OdQJkuY6vWYyN1PtJsqOQtRBm0azWjgqR6sSxr7eCe3qtBZWdIact6KTvnyG/ftH8fyQJQuzEp98i2G8BGPjFep+lUKuneX5OutXldkTG3bu0OgrBwhNwtLFrVxyts/YaIn/+xsPa9vPlw8tJhxfhKe8FS9PLq6Rr+VkUw0/CcgXuuRgcirZFpFvTIPyUVVxVmVaaSu3MjDZKyKWaWursHdnkb5gUgtow9KlIZ21KgMjLQwrrk2vsPZKO1ajal26k0TxB7PEoz2sX7qCxIwyoG3csGJZ15tjtaZAOX+S3QeqRD606m1S8VqoiPXWV6P9dupegBcMCS8oFLLsLZXYGdUZHGsjqrRoQMgQk9ObU3cvgXCCvDYLPFOnnh0jX83j1yw2N0G2nCEjx69kxtW2HBlhYk25mdypYavXuDb5pRYmHBoP+dr3xvjs18t8/jsH2aYF7HZtdRpPBDitlSAosnrlAibkMAPjCb4Fn6ouFc7dspaoGvHYrkPExuDXs2hThzdddCabli5g+/17+MI3nmT3SE6dXwBNj0zUTeIm1Dzz4VmU7mt0zTAZ5hjJ5niiVuMHD+2lNZehr6udxw+OSV87S7ozLOntJJv1GC+UGSl5lL0ck3L8X2wf4Ut3jfPfbhvg5rt3sG7ZAi45ZzUFOe/gZJXe7hwd7SF9PZ34od4KWp9U4kB1G43hCUaLX2MNIIMUW9eoXfC7+PnjY3zq5gf5h+9u4zM3/5L79hYohC0ijxUukchbnyqikvP5nBcEiKylUIz50c8e4+s/3sO3bt/LHn0c29lfImNiVi3KqFOHOGtND6VimYEJ8BOfwNaIvDKbNvbRGgY8uW+SkaJHhjZaTYG1fQXe//uv5vwtS7hnez9/908Ps2c4Q+xQ08hsRRae7fCKJMajavv4j3/7Qz7wN7fz0f/3Ce7bvlejdcC60zo4OFKkJZtheXtMhy2zemk7pcIEk9rWrBuoaDH84AOPcYu2Tb91Xz8l08ZrLz4P9x+TGFN7S+UKG5a1kqHI0q4srUHMULnKcCEhksP7Hprn6yKium8GHnHD2oaL6y1ltUCvVyISoVPXGyMxetZob1y+pJF13l8cOk3fSF9738t7Az7wh5fz6levJPLqFCZDDh6eoDOMOU1zbLSdt3FFrwbvEof1JdRqdPXkAPID8t4oF2xZzf6DRX0F9qngXKWm0XOY3rYDXPeO5Vym7cKDQ938/acf4ZBmYW5aYU30PNhZjcLQ3tZCV1eO3p4sl2xewB9dfR6mPEKtWud07aRkjCWQA65Z0UO5OEFhvE5gKrRnY666cDN/8pYLeOdlZ2l3apwv3fhl9g5VGSwGVCYLbF7dKxtiunIhSzsy1LUaHRiPsYGPTSIRQHfXThMrX0Jgq+STCV7/kmV85N0X83/+zgV86N0XcckZPbQmBXwtlhMRAi3CVWDen968aKFnaNUUZ/1pMYu7I419CUNyokLdsnTJUuKwl4JZzJLlGwjCDHtHi1S1Y4L7Ykuo5d0Yrzx3uT6Sldl7qMSEplQTfgflZAlGb4qe7DDXvup0zjg7y+7RhDsfGNYYKei0Y/Ks+NmMnC+R7mH++Lrz+Mt/s5m/+uOVvP+ac1jVHTMwNklNi9FVi0+j4C+k4HWzdP16xmoeQ/owZk1CxqvrrdDNRetyvOtlHbzu/DWMRQG3PrCfgckspYph8cpVjPndlG07y5atpFhDbY9wf5Ns5MxGUyAcob2ExPhYg9y7StZO0JEMkI/208ohbYVOEiSe2psjISDxYhrs5cQeL7Z278U24HjUXwmqUlMnTHztCrXo9Z/n4MQko/WEw1rw/uONP+aT/3IX13/tVqIwrxF0XNMLo/5tIdZukNFou/K0HH0Le9j2xG7t1lge2D3GF77yKMXJHsJ6iNaoXHZFSNEfYP+gp23BPJ6mOKr4Gc9EI64nV3LfAxb6GRaJaEtiEbXej9Fbac9YjYnI59Gtj/Ppb97JP3/rDm57cDuTQSe7hmpUvYBIU6yq5xH6RVrjfSzryWDzC9h5sMzhkSrO6b//iwe5/nt3c8Mtd/Dk/qGGziGt9OW+GJNgnMejbjZWpPWl06fmhbgPgG73xwYeNT+mrrhIVIhtGyBsjFvQWub7IWSaqInqjyAKqOVGqGkXpl2d5eau3dUsRC1qSEg9ruNrJCuMZ6gVfMYn23j4oVG2PTTEow+NE1fbKB0YZcTro+6XaDWKSzroCsusXdPSmH931jMMHm7hG/eMM+rXwCuSZCbZ2Ho6geb+boTMxmN4VUvkdRBo98bqW0FVNrRrfA20Y+PL8WKNuHVPZmmdARNgqrIzx4jqOjhexa/47BnN8NBjA9z1xBB7th6k1Z9gz0iFqvb9c6aOR4KWOCD9WROS9SOKUY19Y0WijOGJbQd45IEK9+wYY//kGKEw2lGMGE4WNXapiqEM0JmptkpXhI3dPVGaR6jdtER1ZEsZymGFmnFpeaq5IibOC8e6tgkCQk2njDHCrIe6l8FUDmG8kLIGj1a1yTOIXIpXDTTZIWiayOKgJkcICKIsoZmkZ4HlkD78HMZSzIZyVsPuwf2YTF3Ti0m8eD/v/4NNfPTfnctH/+R8PvKBs3jDZR3aQZng4HAk18rKuUIBYMj4EWec3klLaEjkLLkO7YJkYh7ZGWshu556tJjHtcXomYRFbVWybXnuOxxQTKraIswxaCy7xvbQsqCGaRkVMXxZ5WkEDkn0AQwtVTWwyn6fqqYvhaE6i7rqfOC95/Ph917CR99zCR+87nLOXLWIwf4hjGkhiRNNo5AO4y4kniWyHhXbweHBcc5d284Hf/8S/vI95/Gh3ztfH+lezdJchVhp3uSEdnJqcuJYdliVjUBTrtCUReIhPDOh9seSDMiZfWNoSYY1JTqs7wU12R/KqVvwlbYgZ+hlnIn+J6lrcIlyp9NvexjSNG5hdwshqsckspGmO7xmsjgONIIKbk9fXd2e95mb2zl0eIR/+OKT3HxHwhe+vYeHt43Tnl9EPttNX+sCOVQL6xYmnN6bZc3CEptWdGFMnp17DjScy6rfHAYhFVYtsizq9An0Ffe0vohFp2X56i0P8bVbD3Pz7YN86fsPEopcr39ZHysXhDy4e5gbvrWHm38R89mvPc7e/SU2LF9FbyaHpvJ4RLjFLXprxBq9E6Oa5CilUsCEpkBrVrSwum+EDd1l1veMccbCKqf3tVMsVPQmcgT18a3F6F/DWA0AxkSUaz4jw5OcsSTPut4S67oHpWNUUmftwnb2aw0xTJ4B08O/bivzxbvHueH+AjfeW+G+gzCa6eGuQ3W+dO8IX763yuceqHKT3nZ7CwGFoIOf7Ei44ZdlbnigxJfvG2ZXKUeU69ZbZpjP3znAjY/W+OKtDzM4dIjNpy8k79XUsAQSiZ6a6fSaydhEziCUZXKWwFa44OV9rF/ezgN3j/LFL93LD370KH4U87bXvgxb3snK0zoJtetBHCFfhLhOb1uOBR0+k0OP0c4YLV4F519G+VYu9FnVW6MzM8GavhqXvnQpxfERvv79O/jCd+5h54GDnLOhl6suOI13vmolC5J9fP/OA3zuaw9x9z17WdmV5/XnrqFTtrk3RYudoDXRaJ4UQPMER7Z6UKdkSxQmD7NmeTcZ5UVrA6IiLaYkm9v0rigwPrSX0KviU0WGg94wrWFEpxkjmdivdUlBa4J2kbWC5jWYJCITVVnV102ptJ/YDlIXqX9y1xN87UdPcNOPdorIj/HErkE1N8PDTxzmG7dt46s/fpyv3PY4N9/6BCOjJZlpuP+hAb5+23a+ccd2vvqT+9m+ez+/demFegvW+MG9j/MvP7yb7du3s6EvxwUbl0xh7PpGbxGa7PBePHtfeM2BRmZNvEFAG7Is77X8xf9+Mf/2uo1c88YlvOdd6/jEBy/m8pcUuebKHq69ehFZbwjcmyNXwMihli0q8d5r1/GeN57On1z7Eras68E02OHRFsC1rz+DP/rtDfzWmYu49oI1fOgPL+Ztb9zMO648m79+z8W8750X0ZaZ5Nz1ef6f913K7799Dde8fiX/5poz+Kv/Ywvrl41COESrdL7mZYp/1wV05ccxpoqn3RXP5FnQXuW337SJV56xRPNwj8TzIejGJpbNy0Pe/66X8HuvX8Hvv+lsVi/Ok8j5wbCyp4X3XnkOf/TG9fzxO85l/eIsjSSvE2yOQNOxV29Zwl+9YRV/+cbT+NCblvHBq9bzgas286dvPpP36/nfv34VH5b8xRvO4P2y4U+v2sAHpO8DV2zk3772NP78yiX8+RUb+LMr1/K+161TnrO59qXdXL2uzn/53ZfzB5cs450XreP3LtvE+95yPss7E1lWp1kPr5kMN1ELyJHcX11Z8mQ1si5uHeCylxuuvWIJV1ywiDWaErjtvZevW8oZSy3ZmtUAmseagMD20BPEXLAp4FVnZ7jorC6W9Mj5TCIn8/A0R1mz2HDBuT7rtOPSWh/knFVF3nBpH9dc0sllq0t02wPE2uGJKbGqZ5K3npvnXRct44qze1ieF8moEwW9ZG2d9ZpCXbCll3w4IuevYqyHr0X4abmISze1sqy1KgKUtcAuyPlDfNW/oqPIq9bVee1Gq3vIwvYIq/rQ0eZFnLeqlcs2yfYNhiVtY6JUSWUN2f+QZAAABI9JREFUqkDPYyzrqnPR2hVcsn4Bl2xo56IzWtXeLK84E87fGHLxek96M7xyQyuvUNr5m0Ll8RVu4/x1ARcqj0u7eEPAK9d1cZ70bFrWSlc8wNqOCq85ZxlvOXcZr93QweJgTIvpSRFAGMu+Zjy9pjLar0Lcim9rmhpMQtKKhnXkuZoKRFr0xQoHEARKryvdA60ZjF7PJlGapgnG+MqLikS61CQRnuYmnvLIQ1UuIaORFDkbYQKmTj6uiDzSp7JWo7Wv0d3HkpBDlYAvW/wiRv/82Jd9Lm9GplX0LImVL8mj+RmEE5ikxeUEfbvAz+LXMhjVg1fHyAKjD1eNkV1xgezyEx+ch3tW91rDlkBE8/QWNDaPCcpgjdrRplsF/AkycVXOGTXqD5Ma+cjqQ1rstGBEqKy+PLck5QZmGeGCCOvU55KqyKv2qHUZTQtzSUW1WJUJASM0i0ovSk9VwUT1+njOPmewBhKa7PCay14rc43E3Z24ZwXVMe7qxMVaY7D6x1Hx6imdLpXnPVxfuky2od4c0SKd0suREI3D6OpEt6NO5Twq5OqczuOenbiwRCfSZyQyjpnjafXMpDQenIapB6Obk+kY96yoRtvd/SiZasxMxLSN022dSWg8TOtrBKYuR1S7weQptk6lNu21yQjQtDinhs9RBFICvBgdk9Y5ZxBICTBnuiI15MVAICXAi4F6WuecQSAlwJzpitSQFwOBlAAvBuppnXMGgZQAc6YrTg1D5lorUwLMtR5J7TmpCKQEOKlwp5XNNQRSAsy1HkntOakIpAQ4qXCnlc01BFICzLUeSe05qQicRAKc1HallaUIzAqBlACzginNNF8RSAkwX3s2bdesEEgJMCuY0kzzFYGUAPO1Z9N2zQqBlACzguk3zJQWn7MIpASYs12TGnYyEEgJcDJQTuuYswikBJizXZMadjIQSAlwMlBO65izCKQEmLNdMz8Mm+utSAkw13sote+EIpAS4ITCmyqf6wikBJjrPZTad0IRSAlwQuFNlc91BFICzPUeSu07oQicQAKcULtT5SkCxwWBlADHBcZUSbMikBKgWXsutfu4IJAS4LjAmCppVgRSAjRrz6V2HxcEUgIcFxiPUZIGmwaBlABN01WpoScCgZQAJwLVVGfTIJASoGm6KjX0RCCQEuBEoJrqbBoEUgI0TVc1h6HNZmVKgGbrsdTe44pASoDjCmeqrNkQSAnQbD2W2ntcEUgJcFzhTJU1GwIpAZqtx1J7jysCx5EAx9WuVFmKwElBICXASYE5rWSuIpASYK72TGrXSUEgJcBJgTmtZK4ikBJgrvZMatdJQSAlwPGAOdXRtAikBGjarksNPx4IpAQ4HiimOpoWgZQATdt1qeHHA4HmIoBRk53ohrtPiwufaDFWVUp0xwmWqTuzP1TkKZmfEp5ujO5Wotpw0njm1z6MU/VcpZ83w3MVnqNps2yTg6a5CHAEb+c3R8uR6ON6s87BXSUzWhVwiDlxaTMyk+F5Hxo6n5JLOp8SdsqPladkOK6B6Zocz2ZENTjOOWnEKfxcZ9OmHYH+fwEAAP//+FXPtQAAAAZJREFUAwBScUHjUjRjpgAAAABJRU5ErkJggg==";
    }

    // ── Inicio ─────────────────────────────────────────────────────────────────
    Auth.requireAuth(['admin', 'superadmin', 'preceptoria', 'profesor']);

    Auth.onReady(async (profile) => {
        if (!profile) return;

        const pill   = $('userPill');
        const nameEl = $('headerUserName');
        const roleEl = $('headerRoleTag');
        if (pill)   pill.style.display = '';
        if (nameEl) nameEl.textContent = Auth.getName();
        if (roleEl) { roleEl.textContent = Auth.getRoleLabel(); roleEl.className = `role-tag ${profile.role}`; }
        if (profile.role === 'admin' || profile.role === 'superadmin') { const l = $('adminLink'); if(l) l.style.display = ''; }

        const saved = getSessionInst();
        if (!saved) { window.location.href = 'index.html'; return; }
        institutionId   = saved.id;
        institutionName = saved.name || Auth.getInstitutionName() || saved.id;

        // Pre-fill school year with current year
        if ($('schoolYear') && !$('schoolYear').value) {
            $('schoolYear').value = new Date().getFullYear();
        }

        await Promise.all([loadData(), preloadLogo()]);

        // Suscribirse a cambios en tiempo real de la colección de materias.
        // Cuando el admin agrega/quita alumnos, esta página se actualiza sola
        // (2s de debounce para agrupar escrituras en batch).
        if (typeof DB !== 'undefined' && DB.subscribeToInstitutionSubjects) {
            let _firstSnap = true;
            let _refreshTimer = null;
            DB.subscribeToInstitutionSubjects(institutionId, () => {
                if (_firstSnap) { _firstSnap = false; return; } // ignorar snapshot inicial
                clearTimeout(_refreshTimer);
                _refreshTimer = setTimeout(() => {
                    if (document.visibilityState === 'visible') refreshData();
                }, 2000);
            });
        }
    });

    $('logoutButton').addEventListener('click', () => {
        window._gansoLogout = true;
        // Prevenir ghost state: limpiar datos locales de la sesión antes de cerrar.
        // Necesario cuando el usuario trabajó en index.html y cerró sesión desde aquí.
        try {
            const inst = institutionId ? String(institutionId).replace(/[^a-zA-Z0-9]/g, '_') : 'local';
            const prefix = `notas_docente_v2_${inst}_`;
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
            keys.forEach(k => localStorage.removeItem(k));
            localStorage.removeItem(`ganso_last_subject_v2_${inst}`);
            localStorage.removeItem('notas_docente_estado_v2');
        } catch(_) {}
        Auth.signOut();
    });

    // ── Carga de datos ─────────────────────────────────────────────────────────
    async function loadData() {
        if (_refreshInFlight) return;
        _refreshInFlight = true;
        try {
            allSubjectData = await DB.getAllSubjectDataForInstitution(institutionId);
            allSubjectData.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(allSubjectData);

            if (!allSubjectData.length) {
                $('controlsLoading').innerHTML = '<p style="color:var(--muted);font-size:13px;">No hay materias inicializadas.</p>';
                return;
            }

            $('controlsLoading').style.display = 'none';
            $('boletinForm').style.display = '';
            $('boletinOptions').style.display = '';
            populateCourseSelect();
        } catch(err) {
            $('controlsLoading').innerHTML = `<p style="color:var(--danger);">Error: ${escHtml(err.message)}</p>`;
        } finally {
            _refreshInFlight = false;
        }
    }

    // ── Selectores de curso / alumno ───────────────────────────────────────────
    function populateCourseSelect() {
        const sel = $('courseSelect');
        sel.innerHTML = FIXED_COURSES.map(c => `<option value="${c}">${c}</option>`).join('');
        sel.addEventListener('change', () => populateStudentSelect(sel.value));
        populateStudentSelect(sel.value);
    }

    function getStudentsForCourse(course) {
        // Estrategia: buscar el doc con notas numéricas reales más reciente.
        // Los docs de initializeSubject() tienen grades: "" (vacíos); el Excel importa números.
        // Ordenar por updatedAt desc para que el import más reciente gane.
        const sorted = [...allSubjectData].sort((a, b) =>
            (b.updatedAt || '').localeCompare(a.updatedAt || '')
        );

        // Overrides unificados de todos los docs para este curso
        const overrides = getUnifiedCourseOverrides(course);

        for (const doc of sorted) {
            const recs = doc.records?.[course];
            if (!recs || typeof recs !== 'object') continue;
            const hasRealGrade = Object.values(recs).some(rec =>
                Object.values(rec?.grades || {}).some(v =>
                    v !== '' && v !== null && v !== undefined && !isNaN(parseFloat(v))
                )
            );
            if (!hasRealGrade) continue;
            const enrolled = doc.students?.[course];
            const names = Array.isArray(enrolled) && enrolled.length > 0
                ? enrolled
                : Object.keys(recs);
            const valid = names.filter(s => typeof s === 'string' && s.trim());
            if (valid.length > 0) return applyOverridesToList(valid, overrides);
        }

        // Fallback inicio de año (ninguna materia tiene notas aún):
        // usar el doc con la lista de alumnos más reciente
        for (const doc of sorted) {
            const arr = doc.students?.[course];
            if (Array.isArray(arr) && arr.length > 0) return applyOverridesToList([...arr], overrides);
        }

        return [];
    }

    function populateStudentSelect(course) {
        const students = getStudentsForCourse(course);
        const sel = $('studentSelect');
        sel.innerHTML = '<option value="__all__">— Todos los alumnos del curso —</option>' +
            students.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        $('batchWrap').classList.remove('hidden');
    }

    // ── Refresco de datos (sin resetear selectores) ────────────────────────────
    async function refreshData() {
        if (!institutionId || _refreshInFlight) return;
        _refreshInFlight = true;
        try {
            const fresh = await DB.getAllSubjectDataForInstitution(institutionId);
            fresh.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(fresh);
            allSubjectData = fresh;
        } catch (_) {} finally {
            _refreshInFlight = false;
        }
    }

    // ── Clave localStorage por materia (espejo de storageKey() en script.js) ────
    function subjectStorageKey(subject) {
        const instNorm = String(institutionId || 'local').replace(/[^a-zA-Z0-9]/g, '_');
        const subNorm  = String(subject).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
            .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        return `notas_docente_v2_${instNorm}_${subNorm || 'sin_materia'}`;
    }

    // ── Merge localStorage → allSubjectData ───────────────────────────────────
    // Lee la clave por-materia de cada doc y sobreescribe en memoria los datos
    // de Firestore con los locales más recientes, eliminando la race condition
    // entre la escritura sincrónica a localStorage y la asíncrona a Firestore.
    // Si el dato local es más viejo que el remoto (ej: después de restaurar un
    // backup), el remoto gana y no se sobreescribe.
    function _parseLocalTs(s) {
        const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return 0;
        return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
    function mergeLocalStorageData(subjectDataArray) {
        subjectDataArray.forEach((doc, idx) => {
            if (!doc.subject) return;
            try {
                const raw = localStorage.getItem(subjectStorageKey(doc.subject));
                if (!raw) return;
                const local = JSON.parse(raw);
                if (!local || typeof local.records !== 'object' || !local.records) return;
                // Skip if local is genuinely older than the confirmed remote (backup regression guard).
                const localTs  = _parseLocalTs(local.lastSavedAt);
                const remoteTs = doc.updatedAt   ? new Date(doc.updatedAt).getTime()
                               : doc.lastSavedAt ? _parseLocalTs(doc.lastSavedAt) : 0;
                if (localTs > 0 && remoteTs > 0 && localTs < remoteTs) return;
                subjectDataArray[idx] = {
                    ...subjectDataArray[idx],
                    records:          local.records,
                    students:         local.students         || subjectDataArray[idx].students,
                    gradeColumns:     local.gradeColumns     || subjectDataArray[idx].gradeColumns,
                    updatedAt:        local.updatedAt        || subjectDataArray[idx].updatedAt,
                    studentOverrides: local.studentOverrides || subjectDataArray[idx].studentOverrides,
                };
            } catch (_) {}
        });
    }

    // Retorna los removals y additions unificados de todos los docs para un curso dado.
    function getUnifiedCourseOverrides(course) {
        const removalSet  = new Set();
        const additionSeen = new Set();
        const additionList = [];
        allSubjectData.forEach(doc => {
            (doc.studentOverrides?.removals?.[course] || []).forEach(s => removalSet.add(s.toLowerCase()));
            (doc.studentOverrides?.additions?.[course] || []).forEach(s => {
                const key = s.toLowerCase();
                if (!additionSeen.has(key)) { additionSeen.add(key); additionList.push(s); }
            });
        });
        return {
            removalSet,
            additions: additionList.filter(s => !removalSet.has(s.toLowerCase())),
        };
    }

    // Aplica overrides a una lista de alumnos ya filtrada.
    function applyOverridesToList(students, overrides) {
        const result = students.filter(s => !overrides.removalSet.has(s.toLowerCase()));
        const existingKeys = new Set(result.map(s => s.toLowerCase()));
        overrides.additions.forEach(s => {
            if (!existingKeys.has(s.toLowerCase())) { result.push(s); existingKeys.add(s.toLowerCase()); }
        });
        return result.sort();
    }

    // Refrescar automáticamente cuando la pestaña vuelve a estar activa
    // (ej: el usuario cambió notas en otra pestaña y volvió a boletines)
    // Debounced to avoid multiple rapid fetches on minimize/restore in Electron.
    let _visChangeTimer = null;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            clearTimeout(_visChangeTimer);
            _visChangeTimer = setTimeout(() => refreshData(), 500);
        }
    });
    // Refrescar cuando se llega por el botón "Atrás" del navegador
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) refreshData();
    });
    // Actualizar allSubjectData en memoria cuando otra pestaña guarda notas.
    // Así la próxima vista previa o PDF usa datos frescos sin necesitar navegación.
    window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith('notas_docente_v2_') && allSubjectData.length) {
            mergeLocalStorageData(allSubjectData);
        }
    });

    // ── Vista previa ───────────────────────────────────────────────────────────
    $('boletinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await refreshData();
        const course  = $('courseSelect').value;
        const student = $('studentSelect').value;
        if (student === '__all__') renderPreviewAll(course);
        else                       renderPreviewOne(course, student);
    });

    function renderPreviewOne(course, studentName) {
        const data = buildBoletinData(course, studentName);
        if (!data.subjects.length) { showToast('Sin notas para este alumno.'); return; }
        showPreview(boletinPageHTML(course, studentName, data));
    }

    function renderPreviewAll(course) {
        const students = getStudentsForCourse(course);
        if (!students.length) { showToast('No hay alumnos en ese curso.'); return; }

        const pages = students.map((name, i) => {
            const data = buildBoletinData(course, name);
            if (!data.subjects.length) return '';
            return boletinPageHTML(course, name, data);
        }).filter(Boolean);
        const html = pages.join(`<div class="bn-page-sep">${pages.length > 1 ? '' : ''}</div>`);

        showPreview(html || '<p style="padding:24px;color:var(--muted);">Sin alumnos con notas en este curso.</p>');
    }

    function scaleBoletinPages() {
        // CSS handles responsive layout — no JS scaling needed
    }

    function showPreview(html) {
        $('previewPlaceholder').classList.add('hidden');
        const wrap = $('previewContainer');
        wrap.classList.remove('hidden');
        wrap.innerHTML = html;
    }

    // ── Descarga PDF ───────────────────────────────────────────────────────────
    $('downloadBtn').addEventListener('click', async () => {
        await refreshData();
        const course  = $('courseSelect').value;
        const student = $('studentSelect').value;
        if (student === '__all__') await downloadAllPDF(course);
        else                       downloadOnePDF(course, student);
    });

    $('downloadAllBtn').addEventListener('click', async () => {
        await refreshData();
        await downloadAllPDF($('courseSelect').value);
    });

    function downloadOnePDF(course, studentName) {
        const data = buildBoletinData(course, studentName);
        if (!data.subjects.length) { showToast('Sin datos para este alumno.'); return; }
        const doc = buildPDF(course, studentName, data);
        const safe = studentName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
        doc.save(`boletin_${course}_${safe}.pdf`);
        showToast('PDF descargado.');
    }

    async function downloadAllPDF(course) {
        const students = getStudentsForCourse(course).filter(name => buildBoletinData(course, name).subjects.length > 0);

        if (!students.length) { showToast('Sin alumnos con notas en este curso.'); return; }

        const btn          = $('downloadAllBtn');
        const progressWrap = $('batchProgressWrap');
        const progressBar  = $('batchProgressBar');
        const progressText = $('batchProgressText');
        btn.disabled       = true;
        progressWrap.classList.remove('hidden');

        let succeeded = false;
        try {
            let masterDoc = null;
            for (let i = 0; i < students.length; i++) {
                const name = students[i];
                progressText.textContent = `Generando ${i + 1}/${students.length}: ${name}`;
                progressBar.style.width  = `${Math.round(((i + 1) / students.length) * 100)}%`;
                const data = buildBoletinData(course, name);
                if (!masterDoc) masterDoc = buildPDF(course, name, data);
                else            buildPDFPage(masterDoc, course, name, data, true);
                await new Promise(r => setTimeout(r, 0));
            }
            progressText.textContent = 'Descargando...';
            const date = new Date().toLocaleDateString('es-AR').replace(/\//g,'-');
            masterDoc.save(`boletines_${course}_${date}.pdf`);
            succeeded = true;
        } catch (err) {
            console.error('downloadAllPDF error:', err);
            showToast('Error al generar los PDFs. Intentá de nuevo.');
        } finally {
            setTimeout(() => {
                progressWrap.classList.add('hidden');
                progressBar.style.width = '0%';
                btn.disabled = false;
                if (succeeded) showToast(`${students.length} boletines descargados.`);
            }, 500);
        }
    }

    // ── Construcción de datos por alumno ───────────────────────────────────────
    function buildBoletinData(course, studentName) {
        const cfg      = getConfig();
        const subjects = [];
        let studentNumber = null;

        allSubjectData.forEach(doc => {
            const record = doc.records?.[course]?.[studentName];
            if (!record) return;
            if (studentNumber === null && record.number) studentNumber = record.number;

            const cols = doc.gradeColumns?.[course] || GRADE_COLS_DEF;
            const avg  = computeAvg(record.grades, cols);
            const tray = Utils.computeTrajectory(avg, { teaMin: getTeaMin(), tepMin: getTepMin() }) || null;

            subjects.push({
                name:  doc.subject,
                avg,
                tray,
                notes:  record.notes  || '',
                status: record.status || '',
            });
        });

        // Trayectoria general: promedio de los promedios por materia, redondeado igual que el editor
        const validAvgs  = subjects.map(s => s.avg).filter(a => a !== null);
        const overallAvg = validAvgs.length ? Utils.calculateAverage(validAvgs) : null;
        const overallTray = Utils.computeTrajectory(overallAvg, { teaMin: getTeaMin(), tepMin: getTepMin() }) || null;

        return { subjects, overallTray, studentNumber, ...cfg };
    }

    // ── HTML del boletín (preview en pantalla) ─────────────────────────────────
    function boletinPageHTML(course, studentName, data) {
        const { subjects, overallTray, studentNumber, periodo, schoolYear, directorName, directorTitle, instNote } = data;
        const dateStr = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'long',year:'numeric'});
        const titulo  = [periodo, course.toUpperCase(), 'E.S.', schoolYear].filter(Boolean).join(' — ');

        function trayBadge(t, big = false) {
            if (!t) return '<span style="color:#9ca3af;">—</span>';
            const colors = {
                TEA: 'background:#dcfce7;color:#166534;border:1.5px solid #bbf7d0;',
                TEP: 'background:#fef9c3;color:#854d0e;border:1.5px solid #fde68a;',
                TED: 'background:#fee2e2;color:#991b1b;border:1.5px solid #fecaca;',
            };
            const size = big ? 'font-size:16px;padding:5px 18px;' : 'font-size:13px;padding:3px 12px;';
            return `<span style="${colors[t]||''}${size}border-radius:4px;font-weight:900;display:inline-block;letter-spacing:0.04em;">${t}</span>`;
        }

        const subjectRows = subjects.map(s =>
            `<tr>
                <td class="bn-td-mat">${escHtml(s.name)}</td>
                <td class="bn-td-tray">${trayBadge(s.tray)}</td>
            </tr>`
        ).join('');

        const obsRows = subjects.filter(s => s.notes).map(s =>
            `<p style="margin:0 0 5px;font-size:11px;"><strong>${escHtml(s.name)}:</strong> ${escHtml(s.notes)}</p>`
        ).join('');

        const statusText = subjects.filter(s => s.status).map(s => {
            const l = {libre:'Libre',recursante:'Recursante',promovido:'Promovido'}[s.status] || s.status;
            return `${s.name}: ${l}`;
        }).join(' · ');

        return `
        <div class="bn-page-wrapper"><div class="bn-page">

            <!-- Header institucional -->
            <div class="bn-header">
                ${logoBase64
                    ? `<img class="bn-logo" src="${logoBase64}" alt="Logo">`
                    : `<img class="bn-logo" src="data:image/png;base64,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" alt="Logo">`
                }
                <div class="bn-header-text">
                    <div class="bn-school-name">${escHtml(institutionName.toUpperCase())}</div>
                    <div class="bn-school-sub">BOLETÍN DE CALIFICACIONES</div>
                </div>
            </div>

            <div class="bn-thick-line"></div>

            <!-- Título del período -->
            <div class="bn-period-title">VALORACIÓN — ${escHtml(titulo)}</div>

            <!-- Datos del alumno -->
            <table class="bn-student-table">
                <tr>
                    <td class="bn-st-label">N° ALUM.</td>
                    <td class="bn-st-num">${studentNumber !== null ? escHtml(String(studentNumber)) : '—'}</td>
                    <td class="bn-st-label">ALUMNO</td>
                    <td class="bn-st-name">${escHtml(studentName)}</td>
                    <td class="bn-st-label">CURSO</td>
                    <td class="bn-st-course">${escHtml(course)}</td>
                </tr>
            </table>

            <!-- Tabla de materias -->
            <table class="bn-grades-table">
                <thead>
                    <tr>
                        <th class="bn-th-mat">ÁREA / MATERIA</th>
                        <th class="bn-th-tray">${escHtml(periodo || '1° PERÍODO')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${subjectRows || '<tr><td colspan="2" style="padding:14px;color:#9ca3af;text-align:center;font-size:12px;">Sin materias registradas</td></tr>'}
                </tbody>
                <tfoot>
                    <tr class="bn-total-row">
                        <td class="bn-td-total-label">TRAYECTORIA GENERAL</td>
                        <td class="bn-td-tray">${trayBadge(overallTray, true)}</td>
                    </tr>
                </tfoot>
            </table>

            ${statusText ? `<p style="margin:10px 14px;font-size:11px;color:#6b7280;">Estado: ${escHtml(statusText)}</p>` : ''}

            ${obsRows ? `
            <div class="bn-obs-block">
                <div class="bn-obs-label">OBSERVACIONES</div>
                ${obsRows}
            </div>` : ''}

            ${instNote ? `<div class="bn-inst-note">${escHtml(instNote)}</div>` : ''}

            <!-- Firmas -->
            <div class="bn-signatures">
                <div class="bn-sig-col">
                    <div class="bn-sig-dots"></div>
                    <div class="bn-sig-caption">FIRMA PADRE/MADRE/TUTOR O ENCARGADO</div>
                </div>
                <div class="bn-sig-col">
                    <div class="bn-sig-dots"></div>
                    <div class="bn-sig-caption">ACLARACIÓN</div>
                </div>
            </div>

            <div class="bn-director-row">
                <div class="bn-director-line">
                    <div class="bn-sig-dots" style="max-width:240px;"></div>
                    <div class="bn-sig-caption">Firma del Director/a</div>
                    ${directorName ? `<div class="bn-director-name">${escHtml(directorName)}</div>` : ''}
                    ${directorTitle ? `<div class="bn-director-title">${escHtml(directorTitle)}</div>` : ''}
                </div>
                <div class="bn-sello-box">SELLO</div>
            </div>

            <!-- Leyenda -->
            <div class="bn-legend">
                <div class="bn-legend-items">
                    <div class="bn-leg-item"><span class="bn-leg-code">TEA</span><span class="bn-leg-desc">Trayectoria Educativa Avanzada</span></div>
                    <div class="bn-leg-item"><span class="bn-leg-code">TEP</span><span class="bn-leg-desc">Trayectoria Educativa en Proceso</span></div>
                    <div class="bn-leg-item"><span class="bn-leg-code">TED</span><span class="bn-leg-desc">Trayectoria Educativa Discontinua</span></div>
                </div>
                <div class="bn-emission">Fecha de emisión: ${escHtml(dateStr)}</div>
            </div>

        </div></div>`;
    }

    // ── Generación PDF ─────────────────────────────────────────────────────────
    function buildPDF(course, studentName, data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        buildPDFPage(doc, course, studentName, data, false);
        return doc;
    }

    function buildPDFPage(doc, course, studentName, data, addPage) {
        const { subjects, overallTray, studentNumber, periodo, schoolYear, directorName, directorTitle, instNote } = data;
        const PW = 210, PH = 297, ML = 16, MR = 16, W = PW - ML - MR;
        const dateStr = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});
        const titulo  = [periodo, course.toUpperCase(), 'E.S.', schoolYear].filter(Boolean).join(' — ');

        if (addPage) doc.addPage();

        // Helper: draw a filled rect
        const fillRect = (x,y,w,h,r,g,b) => {
            doc.setFillColor(r,g,b);
            doc.rect(x,y,w,h,'F');
        };

        // Helper: text
        const txt = (str, x, y, opts) => doc.text(String(str || ''), x, y, opts);

        // ── Header ────────────────────────────────────────────────
        // Logo (20×20mm, centrado verticalmente en la banda de encabezado)
        let textX = ML;
        if (logoBase64) {
            try { doc.addImage(logoBase64, 'PNG', ML, 7, 20, 20); textX = ML + 25; } catch(_) {}
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor(15, 23, 42);
        txt(institutionName.toUpperCase(), textX, 15);

        doc.setFontSize(8.5);
        doc.setTextColor(71, 84, 103);
        doc.setFont('helvetica', 'normal');
        txt('BOLETÍN DE CALIFICACIONES', textX, 22);

        // Thick divider line
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, 28, W, 1, 'F');
        doc.setFillColor(245, 158, 11);
        doc.rect(ML, 29, W, 0.7, 'F');

        let y = 34;

        // ── Título del período ────────────────────────────────────
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        txt(`VALORACIÓN — ${titulo}`, ML, y);
        y += 7;

        // ── Datos del alumno ──────────────────────────────────────
        doc.setFillColor(248, 250, 252);
        doc.rect(ML, y, W, 10, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.4);
        doc.rect(ML, y, W, 10, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        txt('N° ALUM.', ML + 3, y + 4.5);
        txt('ALUMNO', ML + 26, y + 4.5);
        txt('CURSO', PW - MR - 28, y + 4.5);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        txt(studentNumber !== null ? String(studentNumber) : '—', ML + 3, y + 8.5);
        txt(studentName, ML + 26, y + 8.5);
        txt(course, PW - MR - 28, y + 8.5);

        y += 14;

        // ── Tabla de materias ─────────────────────────────────────
        const COL_MAT  = W - 34;
        const COL_TRAY = 34;

        // Encabezado de columnas
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, y, W, 7, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(255, 255, 255);
        txt('ÁREA / MATERIA', ML + 3, y + 5);
        txt(periodo || '1° PERÍODO', ML + COL_MAT + COL_TRAY / 2, y + 5, { align: 'center' });
        y += 7;

        // Filas de materias
        subjects.forEach((s, i) => {
            const rowH = 8;
            if (i % 2 === 0) {
                doc.setFillColor(248, 250, 252);
                doc.rect(ML, y, W, rowH, 'F');
            }
            doc.setDrawColor(229, 231, 235);
            doc.setLineWidth(0.25);
            doc.line(ML, y + rowH, ML + W, y + rowH);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.5);
            doc.setTextColor(15, 23, 42);
            txt(s.name, ML + 3, y + 5.5);

            // Trayectoria
            if (s.tray) {
                const trayColors = {
                    TEA: { bg: [220,252,231], fg: [22,101,52]  },
                    TEP: { bg: [254,249,195], fg: [133,77,14]  },
                    TED: { bg: [254,226,226], fg: [153,27,27]  },
                };
                const tc = trayColors[s.tray];
                if (tc) {
                    const bx = ML + COL_MAT + 4, by = y + 1.5, bw = COL_TRAY - 8, bh = 5;
                    doc.setFillColor(...tc.bg);
                    doc.roundedRect(bx, by, bw, bh, 1, 1, 'F');
                    doc.setDrawColor(...tc.fg);
                    doc.setLineWidth(0.3);
                    doc.roundedRect(bx, by, bw, bh, 1, 1, 'S');
                    doc.setTextColor(...tc.fg);
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(8);
                    txt(s.tray, ML + COL_MAT + COL_TRAY / 2, y + 5.8, { align: 'center' });
                }
            } else {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8);
                doc.setTextColor(156, 163, 175);
                txt('—', ML + COL_MAT + COL_TRAY / 2, y + 5.5, { align: 'center' });
            }

            y += rowH;
        });

        // Fila de trayectoria general
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, y, W, 9, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(253, 230, 138);
        txt('TRAYECTORIA GENERAL', ML + 3, y + 6);

        if (overallTray) {
            const trayColors = { TEA: [134,239,172], TEP: [253,230,138], TED: [252,165,165] };
            doc.setTextColor(...(trayColors[overallTray] || [255,255,255]));
            doc.setFontSize(9);
            txt(overallTray, ML + COL_MAT + COL_TRAY / 2, y + 6.2, { align: 'center' });
        }

        // Border around full table
        doc.setDrawColor(15, 23, 42);
        doc.setLineWidth(0.5);
        doc.rect(ML, y - (subjects.length * 8) - 7, W, (subjects.length * 8) + 7 + 9, 'S');
        // Vertical separator
        doc.line(ML + COL_MAT, y - (subjects.length * 8) - 7, ML + COL_MAT, y + 9);

        y += 13;

        // ── Observaciones ─────────────────────────────────────────
        const withNotes = subjects.filter(s => s.notes);
        if (withNotes.length) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            txt('OBSERVACIONES', ML, y);
            y += 5;
            withNotes.forEach(s => {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(8);
                doc.setTextColor(15, 23, 42);
                txt(`${s.name}:`, ML, y);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(71, 84, 103);
                const lines = doc.splitTextToSize(s.notes, W - 32);
                txt(lines, ML + 28, y);
                y += 4.5 * lines.length + 1.5;
            });
            y += 3;
        }

        if (instNote) {
            doc.setFont('helvetica', 'italic');
            doc.setFontSize(8);
            doc.setTextColor(120, 53, 15);
            const lines = doc.splitTextToSize(instNote, W);
            txt(lines, ML, y);
            y += 4.5 * lines.length + 5;
        }

        // ── Firmas ────────────────────────────────────────────────
        const sigY = Math.max(y + 8, PH - 52);

        // Línea dotted para firma
        doc.setDrawColor(156, 163, 175);
        doc.setLineWidth(0.4);
        const halfW = (W - 8) / 2;

        // Firma padre/tutor
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML, sigY, ML + halfW, sigY);
        doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        txt('FIRMA PADRE/MADRE/TUTOR O ENCARGADO', ML, sigY + 4);

        // Aclaración
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML + halfW + 8, sigY, ML + W, sigY);
        doc.setLineDashPattern([], 0);
        txt('ACLARACIÓN', ML + halfW + 8, sigY + 4);

        const dirY = sigY + 14;
        // Firma director
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML, dirY, ML + halfW, dirY);
        doc.setLineDashPattern([], 0);
        txt('Firma del Director/a', ML, dirY + 4);
        if (directorName) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(15, 23, 42);
            txt(directorName, ML, dirY + 9);
        }
        if (directorTitle) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(100, 116, 139);
            txt(directorTitle.toUpperCase(), ML, dirY + 13.5);
        }

        // Cuadro "SELLO"
        const selX = ML + halfW + 8, selY = dirY - 2, selW = halfW, selH = 18;
        doc.setDrawColor(180, 192, 207);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([2, 2], 0);
        doc.rect(selX, selY, selW, selH, 'S');
        doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(156, 163, 175);
        txt('SELLO', selX + selW / 2, selY + selH / 2 + 2, { align: 'center' });

        // ── Leyenda ───────────────────────────────────────────────
        const legY = PH - 14;
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.4);
        doc.rect(ML, legY, W, 10, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        const legItems = [
            ['TEA', 'Trayectoria Educativa Avanzada'],
            ['TEP', 'Trayectoria Educativa en Proceso'],
            ['TED', 'Trayectoria Educativa Discontinua'],
        ];
        const legColW = W / 3;
        legItems.forEach(([code, desc], i) => {
            const lx = ML + legColW * i + 3;
            doc.setTextColor(15, 23, 42);
            doc.setFont('helvetica', 'bold');
            txt(code, lx, legY + 5);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(71, 84, 103);
            txt(desc, lx + 9, legY + 5);
        });

        // Fecha de emisión (abajo derecha)
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(156, 163, 175);
        txt(dateStr, PW - MR, legY + 9, { align: 'right' });
    }
