import { crc32 } from '../crc32.js';

// Normative dictionary from Blockchain Commons BCR-2020-012 (Bytewords).
// https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-012-bytewords.md
const words =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';
const values = new Map<string, number>();
for (let i = 0; i < 256; i++) values.set(words[i * 4]! + words[i * 4 + 3]!, i);

/** Decode minimal Bytewords and verify its big-endian CRC-32 suffix. */
export function decodeBytewords(text: string): Uint8Array {
  if (text.length < 10 || text.length % 2 !== 0) throw new Error('Invalid Bytewords length');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const value = values.get(text.slice(i * 2, i * 2 + 2));
    if (value === undefined) throw new Error('Invalid Bytewords pair');
    bytes[i] = value;
  }
  const body = bytes.subarray(0, -4);
  const checksum = new DataView(bytes.buffer).getUint32(body.length);
  if (crc32(body) !== checksum) throw new Error('Bytewords checksum mismatch');
  return body;
}
