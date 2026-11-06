const form = document.querySelector("#setup");
const button = document.querySelector("#start");
const result = document.querySelector("#result");
const secret = document.querySelector("#secret");
const intro = document.querySelector("#intro");
const botLink = document.querySelector("#bot-link");

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  secret.disabled = true;
  result.textContent = "Настраиваем…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);
  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "x-setup-token": secret.value.trim() },
      signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error("Сервер вернул некорректный ответ"); }
    if (!response.ok) throw new Error(data.error || "Ошибка настройки");
    // has_main_web_app = false значит, что кнопка «ОТКРЫТЬ» в списке чатов ещё
    // не задана в BotFather — не отчитываемся об успехе, как о полной активации.
    result.textContent = data.has_main_web_app === false
      ? "Готово: база и webhook обновлены. Но кнопка «ОТКРЫТЬ» не появится, пока Main Mini App не задана в @BotFather (/mybots → Bot Settings → Mini Apps)."
      : "Готово. База обновлена, webhook и кнопка Mini App активированы.";
    intro.textContent = "DuoPlan подключён к Telegram.";
    form.hidden = true;
    botLink.classList.remove("hidden");
  } catch (error) {
    result.textContent = error.name === "AbortError" ? "Сервер не ответил за 40 секунд. Повторите попытку." : error.message;
    secret.disabled = false;
    // При ошибке поле оставляем заполненным: повторный ввод секрета вручную —
    // лишняя фрикция. Очищаем только при успехе.
    return;
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
  secret.value = "";
});
