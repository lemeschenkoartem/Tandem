'use strict';
(() => {
  const labels = { action: 'Действие', section: 'Раздел', state: 'Состояние', kind: 'Вид', count: 'Количество', codec: 'Кодек', resolution: 'Разрешение', fps: 'Кадров/с', bitrate: 'Мбит/с', mode: 'Режим', result: 'Результат', reason: 'Причина', code: 'Код для диагностики', server: 'Сервер', route: 'Маршрут', version: 'Версия', platform: 'Система', source: 'Источник', duration: 'Время, мс', phase: 'Этап', role: 'Роль', rtt: 'RTT, мс', p95: 'RTT p95, мс', encode: 'Кодирование, мс', decode: 'Декодирование, мс', buffer: 'Буфер, мс', qp: 'QP (не оценка резкости)', loss: 'Потери, %' };
  const events = {
    start: ['ИНФО', 'Приложение запущено'], stop: ['ИНФО', 'Приложение закрывается'],
    action: ['ИНФО', 'Действие пользователя'], view: ['ИНФО', 'Открыт раздел'],
    settings: ['ИНФО', 'Настройки сохранены'], error: ['ОШИБКА', 'Действие не выполнено'], warning: ['ВНИМАНИЕ', 'Требуется проверка'],
    capture: ['ИНФО', 'Захват монитора начат'], consent: ['ИНФО', 'Получен ответ на запрос разрешения'],
    direct_offer: ['ИНФО', 'Приглашение создано. Ожидаем ответ друга'], direct_received: ['ИНФО', 'Приглашение друга получено'],
    direct_answer: ['ИНФО', 'Ответ создан. Его нужно передать владельцу и применить у него'], direct_applied: ['ИНФО', 'Ответ друга применён. Начинаем устанавливать связь'],
    wait_expired: ['ВНИМАНИЕ', 'Истекло время обмена приглашением и ответом. Это ещё не подтверждает проблему NAT'],
    connect_timeout: ['ОШИБКА', 'Не удалось установить связь после обмена ответом'],
    peer_state: ['ИНФО', 'Изменилось состояние соединения'], ice_state: ['ИНФО', 'Проверка сетевых маршрутов'],
    ice_candidate: ['ИНФО', 'Найден сетевой маршрут'], ice_error: ['ВНИМАНИЕ', 'Ошибка обращения к STUN/TURN'],
    turn_start: ['ИНФО', 'Начата проверка TURN'], turn_ok: ['ИНФО', 'TURN доступен и выделил маршрут'], turn_failed: ['ОШИБКА', 'TURN не выделил маршрут'],
    network_probe: ['ИНФО', 'Проверен путь Tailscale'],
    connected: ['ИНФО', 'Соединение установлено'], ended: ['ИНФО', 'Сессия завершена'],
    server_state: ['ИНФО', 'Связь со службой аккаунтов'], authenticated: ['ИНФО', 'Вход в аккаунт выполнен'],
    server_event: ['ИНФО', 'Ответ службы аккаунтов'], quality: ['ИНФО', 'Изменено качество трансляции'], metrics: ['ИНФО', 'Состояние работающего потока'],
    control: ['ИНФО', 'Изменено разрешение управления'], swap: ['ИНФО', 'Смена ролей участников'], crash: ['ОШИБКА', 'Сбой компонента приложения'],
  };
  function text(value) {
    return String(value).replace(/tandem:\/\/\S+/gi, '[приглашение скрыто]').replace(/((?:password|credential|token|apikey|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[скрыто]').replace(/[\r\n\u2028\u2029\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 360);
  }
  function error(value) {
    const name = value?.name || 'Error';
    const messages = { SyntaxError: 'Некорректный формат данных. Проверьте JSON настроек или файл приглашения.', NotAllowedError: 'Доступ к захвату экрана или устройству не разрешён.', NotFoundError: 'Выбранный экран или устройство недоступны.', NotReadableError: 'Не удалось прочитать экран или устройство. Проверьте, не занято ли оно другой программой.', OverconstrainedError: 'Выбранный режим захвата не поддерживается. Уменьшите разрешение или FPS.', InvalidStateError: 'Это действие недоступно на текущем этапе подключения.', OperationError: 'Не удалось выполнить операцию WebRTC. Проверьте этапы соединения в журнале.', NetworkError: 'Не удалось связаться с сетевым сервисом.', AbortError: 'Операция отменена или истекло время ожидания.' };
    if (messages[name]) return messages[name];
    const message = (typeof value === 'string' ? value : value?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if (/^[А-Яа-яЁё]/.test(message) && !/[{}]/.test(message)) return text(message);
    return 'Внутренняя операция не выполнена. Подробности этапа и код ошибки указаны в журнале.';
  }
  function iceError(code) {
    return ({ 401: 'TURN отклонил данные входа. Проверьте логин и пароль сервера.', 403: 'Сервер запретил этот запрос или адрес назначения.', 438: 'Срок служебного ключа TURN истёк; WebRTC обычно повторяет запрос.', 486: 'Исчерпана квота или число подключений TURN.', 508: 'TURN не хватает ресурсов для выделения маршрута.', 701: 'Не удалось обратиться к этому STUN/TURN. Проверьте адрес, DNS, порт и доступность транспорта.' })[Number(code)] || 'STUN/TURN сообщил об ошибке. Другие настроенные маршруты ещё могут сработать.';
  }
  function format(event, data = {}, date = new Date()) {
    if (!Object.hasOwn(events, event)) throw new Error('Неизвестное событие журнала.');
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    const offset = -date.getTimezoneOffset(), absolute = Math.abs(offset), pad = (v, n = 2) => String(v).padStart(n, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset >= 0 ? '+' : '-'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
    const details = Object.entries(labels).filter(([key]) => Object.hasOwn(data, key) && ['string', 'number', 'boolean'].includes(typeof data[key])).map(([key, label]) => `${label}: ${text(data[key])}`);
    return `${stamp} | ${events[event][0]} | ${events[event][1]}${details.length ? '. ' + details.join('; ') : ''}\n`;
  }
  const exported = { format, error, iceError };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported; else globalThis.TandemLog = exported;
})();
