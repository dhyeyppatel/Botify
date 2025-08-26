// config/plans.js
module.exports = {
  limits: {
    free: parseInt(process.env.FREE_BOT_LIMIT || '30', 10),
    premium: parseInt(process.env.PREMIUM_BOT_LIMIT || '999', 10),
    admin: Infinity,
  }
};
