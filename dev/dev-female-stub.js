// Локальный dev-вход: подменяем Telegram WebApp валидной подписью female-профиля.
// Отдельный файл (а не inline-скрипт) — CSP запрещает inline: script-src 'self' https://telegram.org.
window.Telegram = { WebApp: {
  initData: "user=%7B%22id%22%3A100001%2C%22first_name%22%3A%22%D0%90%D0%BD%D1%8F%22%2C%22last_name%22%3A%22%D0%A2%D0%B5%D1%81%D1%82%22%2C%22username%22%3A%22devfemale%22%2C%22language_code%22%3A%22ru%22%7D&auth_date=1794863574&hash=90462e08486c5d8af06d1a24cc84e13ed2faece6fb5d07afe502688cd8af1ac7",
  platform: 'tdesktop', colorScheme: 'dark',
  isExpanded: true, viewportHeight: 800, viewportStableHeight: 800,
  initDataUnsafe: {},
  ready(){}, expand(){}, close(){}, onEvent(){}, offEvent(){},
  setHeaderColor(){}, setBackgroundColor(){}, disableVerticalSwipes(){},
  enableClosingConfirmation(){}, disableClosingConfirmation(){},
  requestFullscreen(){}, exitFullscreen(){}, addToHomeScreen(){}, checkHomeScreenStatus(){},
  sendData(){}, showAlert(){}, showConfirm(){}, showPopup(){}, openLink(){},
  switchInlineQuery(){}, setHeaderButton(){}, openTelegramLink(){},
  HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  BackButton: { isVisible:false, show(){}, hide(){}, onClick(){}, offClick(){} },
  MainButton: { isVisible:false, show(){}, hide(){}, setText(){}, onClick(){}, offClick(){} },
  themeParams: {}, colorScheme: 'dark'
}};
