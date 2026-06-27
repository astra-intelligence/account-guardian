/**
 * Auth middleware — require login for protected routes.
 * Redirects to /auth/login if no session.
 */
function requireLogin(req, res, next) {
  if (req.session && req.session.userId && req.session.userEmail) {
    return next();
  }
  const returnTo = encodeURIComponent(req.originalUrl);
  res.redirect(`/auth/login?return=${returnTo}`);
}

function ifLoggedIn(req, res, next) {
  if (req.session && req.session.userId) {
    req.userEmail = req.session.userEmail;
    res.locals.userEmail = req.session.userEmail;
  }
  next();
}

module.exports = { requireLogin, ifLoggedIn };