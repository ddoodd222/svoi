// Смешные голоса: как складываются эффекты. Без браузера.
// Запуск: node tests/voices.test.mjs

import { toggleVoice, parseVoice, voiceKey } from '../web/js/voices.js';

let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };

ok(toggleVoice('normal', 'chipmunk') === 'chipmunk', 'нажали «Бурундук» — бурундук');
ok(toggleVoice('chipmunk', 'cave') === 'chipmunk+cave', 'добавили «Пещеру» — бурундук в пещере');
ok(toggleVoice('chipmunk+cave', 'chipmunk') === 'cave', 'нажали «Бурундук» ещё раз — осталась пещера');
ok(toggleVoice('cave', 'cave') === 'normal', 'сняли последний эффект — свой голос');
ok(toggleVoice('chipmunk+radio', 'giant') === 'giant+radio', 'бурундук и великан не складываются: великан заменил бурундука');
ok(toggleVoice('robot+radio+cave', 'normal') === 'normal', '«Свой» сбрасывает всё');
ok(toggleVoice('cave', 'robot') === 'robot+cave', 'порядок всегда один: эхо последним');
ok(parseVoice('robot+evil+cave').join() === 'robot,cave', 'чужое имя эффекта отбрасывается');
ok(parseVoice('chipmunk+giant').join() === 'chipmunk', 'из бурундука и великана остаётся один');
ok(voiceKey([]) === 'normal', 'нет эффектов — свой голос');

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
