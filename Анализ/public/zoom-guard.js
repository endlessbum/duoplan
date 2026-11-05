/*
 * Запрет pinch-to-zoom в Mini App DuoPlan.
 *
 * Основной барьер — viewport (`maximum-scale=1, user-scalable=no`) и
 * `touch-action: pan-x pan-y` на корне: они разрешают прокрутку одним пальцем,
 * но не дают браузеру масштабировать страницу. Однако WebView ведут себя
 * по-разному: WKWebView в Telegram iOS исторически игнорирует user-scalable,
 * а Safari шлёт собственные gesture-события. Поэтому дублируем защиту на
 * событиях — аккуратно, не трогая одиночные касания.
 */
(() => {
  "use strict";

  // События WebKit, которые возникают только при жесте масштабирования.
  const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"];

  function install(doc) {
    const target = doc || document;

    // Один палец — обычная прокрутка и тапы: не вмешиваемся вообще.
    // Два и больше — это pinch, отменяем жест до того, как браузер изменит масштаб.
    const blockMultiTouch = (event) => {
      if (event.touches && event.touches.length > 1) event.preventDefault();
    };
    // gesture* не бывают одиночными — они всегда про масштаб.
    const blockGesture = (event) => event.preventDefault();
    // Ctrl+wheel — тот же зум на трекпаде и в десктопных браузерах.
    const blockCtrlWheel = (event) => {
      if (event.ctrlKey) event.preventDefault();
    };

    // passive: false обязателен: с passive браузер игнорирует preventDefault.
    target.addEventListener("touchstart", blockMultiTouch, { passive: false });
    target.addEventListener("touchmove", blockMultiTouch, { passive: false });
    for (const type of GESTURE_EVENTS) {
      target.addEventListener(type, blockGesture, { passive: false });
    }
    target.addEventListener("wheel", blockCtrlWheel, { passive: false });

    return function uninstall() {
      target.removeEventListener("touchstart", blockMultiTouch);
      target.removeEventListener("touchmove", blockMultiTouch);
      for (const type of GESTURE_EVENTS) target.removeEventListener(type, blockGesture);
      target.removeEventListener("wheel", blockCtrlWheel);
    };
  }

  if (typeof document !== "undefined") install(document);

  // install() вынесен наружу для тестов: в браузере он уже вызван.
  window.DuoPlanZoomGuard = { install };
})();
