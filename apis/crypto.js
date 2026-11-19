// 网易云 weapi 加密（AES-128-CBC 双层 + RSA），纯 Node crypto 实现，无外部依赖
const crypto = require('crypto');

const presetKey = Buffer.from('0CoJUm6Qyw8W8jud');
const iv = Buffer.from('0102030405060708');
const publicKey =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n' +
  '-----END PUBLIC KEY-----';

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
}

function weapi(obj) {
  const text = JSON.stringify(obj);
  // 16 位随机密钥
  const secretKey = crypto.randomBytes(8).toString('hex').slice(0, 16);
  const first = aesEncrypt(text, presetKey).toString('base64');
  const params = aesEncrypt(first, Buffer.from(secretKey)).toString('base64');
  const reversed = Buffer.from(secretKey.split('').reverse().join(''));
  const padded = Buffer.concat([Buffer.alloc(128 - reversed.length, 0), reversed]);
  const encSecKey = crypto
    .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, padded)
    .toString('hex');
  return { params, encSecKey };
}

module.exports = { weapi };
