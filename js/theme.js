/* Applies the saved appearance (System / Light / Dark) before the page paints, to avoid a flash. */
(function(){
  try{
    var t = localStorage.getItem('kaban_theme');
    if(t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  }catch(e){}
})();
