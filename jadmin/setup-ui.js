const setupCard=document.createElement('section');
setupCard.className='card';
const setupTitle=document.createElement('h2');setupTitle.textContent='部署与后续配置';
const setupNotice=document.createElement('p');setupNotice.setAttribute('role','status');
setupCard.append(setupTitle,setupNotice);$('app').prepend(setupCard);
async function refreshSetup(){try{const data=await api('/api/admin/setup');setupNotice.textContent=data.notice;}catch(e){setupNotice.textContent=e.message;}}
const setupLoad=load;load=async function(){await refreshSetup();await setupLoad();};
