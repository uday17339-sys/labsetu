/**
 * Parser verification against realistic analyzer output.
 *
 * Parsing is where silent corruption happens: a wrong delimiter assumption or a
 * mis-indexed field produces a plausible-looking number that is clinically
 * wrong. These cases are drawn from how Sysmex, Beckman and Roche analyzers
 * actually format their messages, including the awkward parts.
 *
 * Run: npx tsx src/parsers/parsers.verify.ts
 */
import * as astm from './astm';
import * as hl7 from './hl7';

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  }
}

console.log('\nASTM E1381 / E1394\n');

// --- checksum ----------------------------------------------------------------
// Worked example from the E1381 spec family: the checksum covers the frame
// number through the terminator inclusive.
const frameBody = '1H|\\^&\x03';
check('checksum is 2 uppercase hex digits', astm.astmChecksum(frameBody).length, 2);
check(
  'checksum round-trips through parseFrame',
  astm.parseFrame(astm.buildFrame(1, 'H|\\^&'))?.checksumValid,
  true,
);
check(
  'corrupted frame fails the checksum',
  astm.parseFrame('\x021H|\\^&\x03FF\r\n')?.checksumValid,
  false,
);

// --- a realistic 5-part haematology message ----------------------------------
const sysmexMessage = [
  'H|\\^&|||XN-1000^SN-XN-88421|||||||P|1|20260801093000',
  'P|1||||^^||19740312|M',
  'O|1|HYD26080100011||^^^CBC|R||20260801092500|||||||||||||||||F',
  'R|1|^^^WBC|14.2|10*3/uL|4.0^11.0|H||F||tech01||20260801093000|XN-1000',
  'R|2|^^^HGB|6.2|g/dL|13.0^17.0|LL||F||tech01||20260801093000|XN-1000',
  'R|3|^^^PLT|210|10*3/uL|150^450|N||F||tech01||20260801093000|XN-1000',
  'C|1|I|Severe anaemia flagged|G',
  'L|1|N',
].join('\r\n');

const astmObs = astm.toObservations(sysmexMessage);
check('parses every R record', astmObs.length, 3);
check('specimen id comes from the O record', astmObs[0]?.specimenRef, 'HYD26080100011');
check('test code extracted from componentised Universal Test ID', astmObs[0]?.testCode, 'WBC');
check('value preserved verbatim', astmObs[1]?.value, '6.2');
check('units captured', astmObs[1]?.units, 'g/dL');
check('abnormal flag captured', astmObs[1]?.abnormalFlags, 'LL');
check('result status mapped', astmObs[1]?.resultStatus, 'FINAL');
// 09:30:00 IST is 04:00:00 UTC.
check(
  'analyzer local time converted from IST to UTC',
  astmObs[0]?.observedAt,
  '2026-08-01T04:00:00.000Z',
);
// The C record follows R|3 (PLT), so it belongs to that observation.
check(
  'comment attached to the preceding result',
  astmObs[2]?.rawFields.comment,
  'Severe anaemia flagged',
);

// --- non-standard delimiters -------------------------------------------------
// The header DECLARES the delimiters. An analyzer using '#' as the field
// separator is unusual but legal, and hardcoding '|' would silently produce
// garbage rather than an error.
const oddDelimiters = [
  'H#\\^&#||ODD-ANALYZER',
  'O#1#SPEC999##^^^GLU#R',
  'R#1#^^^GLU#105#mg/dL#70^100#H||F',
  'L#1#N',
].join('\r\n');

const oddObs = astm.toObservations(oddDelimiters);
check('reads delimiters from the H record', oddObs.length, 1);
check('non-standard delimiter: specimen', oddObs[0]?.specimenRef, 'SPEC999');
check('non-standard delimiter: code', oddObs[0]?.testCode, 'GLU');
check('non-standard delimiter: value', oddObs[0]?.value, '105');

// --- values that must NOT be coerced to numbers ------------------------------
const boundedValues = [
  'H|\\^&|||ANALYZER',
  'O|1|SPEC001||^^^TSH|R',
  'R|1|^^^TSH|<0.01|uIU/mL|0.4^4.0|L||F',
  'R|2|^^^HBSAG|NEGATIVE||||F',
  'R|3|^^^FER|>1000|ng/mL|30^400|H||F',
  'L|1|N',
].join('\r\n');

const bounded = astm.toObservations(boundedValues);
check('"<0.01" preserved, not coerced to 0.01', bounded[0]?.value, '<0.01');
check('"NEGATIVE" preserved as a qualitative result', bounded[1]?.value, 'NEGATIVE');
check('">1000" preserved, not coerced to 1000', bounded[2]?.value, '>1000');

console.log('\nHL7 v2.5 ORU^R01\n');

const beckmanMessage = [
  'MSH|^~\\&|AU480|SUNRISE|LABSETU|LAB|20260801094500||ORU^R01|MSG00042|P|2.5',
  'PID|1||SUN000008||NAIDU^VENKATESH||19790215|M',
  'OBR|1|HYD26080100012|HYD26080100012|LIPID^Lipid Profile|||20260801093000',
  'OBX|1|NM|CHOL^Total Cholesterol||244|mg/dL|<200|H|||F|||20260801094500',
  'OBX|2|NM|TG^Triglycerides||180|mg/dL|<150|H|||F|||20260801094500',
  'OBX|3|NM|HDLC^HDL Cholesterol||38|mg/dL|>40|L|||F|||20260801094500',
  'NTE|1||Fasting sample',
].join('\r');

const hl7Obs = hl7.toObservations(beckmanMessage);
check('parses every OBX', hl7Obs.length, 3);
check('specimen id comes from OBR', hl7Obs[0]?.specimenRef, 'HYD26080100012');
check('test code from OBX-3 first component', hl7Obs[0]?.testCode, 'CHOL');
check('value from OBX-5', hl7Obs[0]?.value, '244');
check('units from OBX-6', hl7Obs[0]?.units, 'mg/dL');
check('instrument reference range captured (informational)', hl7Obs[0]?.referenceRange, '<200');
check('abnormal flag from OBX-8', hl7Obs[0]?.abnormalFlags, 'H');
check('result status from OBX-11', hl7Obs[0]?.resultStatus, 'FINAL');
check(
  'observation time converted from IST to UTC',
  hl7Obs[0]?.observedAt,
  '2026-08-01T04:15:00.000Z',
);
check('NTE attaches to the preceding OBX', hl7Obs[2]?.rawFields.note, 'Fasting sample');

// --- explicit timezone offset ------------------------------------------------
check(
  'explicit +0530 offset is honoured',
  hl7.parseHl7Timestamp('20260801094500+0530'),
  '2026-08-01T04:15:00.000Z',
);
check(
  'explicit +0000 offset is honoured',
  hl7.parseHl7Timestamp('20260801094500+0000'),
  '2026-08-01T09:45:00.000Z',
);

// --- ACK ---------------------------------------------------------------------
const ack = hl7.buildAck(beckmanMessage, true);
check('ACK echoes the message control id', ack.includes('MSG00042'), true);
check('ACK signals acceptance with AA', ack.includes('MSA|AA'), true);
check('NACK signals error with AE', hl7.buildAck(beckmanMessage, false).includes('MSA|AE'), true);

// --- malformed input must not throw ------------------------------------------
// Analyzers are old embedded devices on a lab LAN. Assume hostile output.
const malformed = [
  '',
  'garbage',
  'MSH|^~\\&|',
  'OBX|1|NM|||||||||F',
  'H|\\^&\r\nR|1||',
  '\x00\x01\x02',
];
let threw = false;
for (const m of malformed) {
  try {
    hl7.toObservations(m);
    astm.toObservations(m);
  } catch {
    threw = true;
  }
}
check('malformed input never throws', threw, false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
