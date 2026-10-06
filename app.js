const clamp01=v=>Math.max(0,Math.min(1,v));
const windowFade=(p,a,b,c,d)=>clamp01((p-a)/(b-a))*clamp01((d-p)/(d-c));

// One shared, demand-driven renderer. Only nearby stories retain decoded frames.
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const sequenceRuntime = (() => {
  const stories = [];
  let raf = 0, previous = 0, dirty = true, busy = 0;
  const wake = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); };
  function measure() {
    stories.forEach(s => {
      s.top = s.section.getBoundingClientRect().top + scrollY;
      s.height = s.section.offsetHeight;
      s.view = s.canvas.parentElement.clientHeight;
      s.width = s.canvas.parentElement.clientWidth;
      s.resize = true;
    });
    dirty = false;
  }
  function pump() {
    while (busy < 4) {
      let chosen, index, priority = Infinity;
      stories.forEach(s => {
        if (!s.near) return;
        const center = Math.round(s.target);
        const radius = s.visible ? 14 : 3;
        for (let d = 0; d <= radius; d++) {
          for (const i of d ? [center + d, center - d] : [center]) {
            if (i < 0 || i >= s.count || s.images.has(i) || s.pending.has(i) || s.failed.has(i)) continue;
            const score = d + (s.visible ? 0 : 100);
            if (score < priority) { chosen = s; index = i; priority = score; }
          }
        }
      });
      if (!chosen) break;
      const s = chosen, i = index;
      busy++; s.pending.add(i);
      const im = new Image();
      im.decoding = 'async';
      im.onload = async () => {
        let decoded = im;
        try {
          await im.decode();
          if (window.createImageBitmap) {
            const max = innerWidth <= 900 ? 1000 : 1600;
            const ratio = Math.min(1, max / im.naturalWidth);
            decoded = await createImageBitmap(im, {resizeWidth: Math.round(im.naturalWidth * ratio), resizeHeight: Math.round(im.naturalHeight * ratio), resizeQuality: 'high'});
          }
        } catch (_) { /* A loaded HTMLImageElement is also a valid canvas source. */ }
        if (s.near) { s.images.set(i, decoded); s.redraw = true; }
        else decoded.close?.();
        finish();
      };
      im.onerror = () => { s.failed.add(i); finish(); };
      function finish() {
        busy--; s.pending.delete(i);
        if (s.failed.size && !s.images.size && s.loader) {
          s.loader.textContent = 'Visual unavailable · continue scrolling';
          s.loader.style.pointerEvents = 'none';
        }
        wake(); pump();
      }
      im.src = s.prefix + String(i).padStart(3, '0') + '.jpg';
    }
  }
  function paint(s) {
    const dpr = Math.min(devicePixelRatio || 1, innerWidth <= 900 ? 1.5 : 1.75);
    if (s.resize || s.canvas.width <= 1) {
      s.canvas.width = Math.round(s.width * dpr);
      s.canvas.height = Math.round(s.view * dpr);
      s.resize = false; s.redraw = true;
    }
    const low = Math.floor(s.current), high = Math.min(s.count - 1, low + 1);
    let a = s.images.get(low), b = s.images.get(high), blend = s.current - low;
    if (!a || !b) {
      const nearest = [...s.images.keys()].sort((x,y) => Math.abs(x-s.current)-Math.abs(y-s.current))[0];
      a = s.images.get(nearest); b = null; blend = 0;
    }
    if (!a) return;
    const key = `${low}:${high}:${Math.round(blend*100)}`;
    if (!s.redraw && key === s.last) return;
    s.last = key; s.redraw = false;
    const ctx = s.ctx, cw = s.canvas.width, ch = s.canvas.height;
    ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0,0,cw,ch);
    function draw(im, alpha) {
      const mobile = innerWidth <= 900, ir = im.width / im.height, cr = cw / ch;
      let w, h;
      if (mobile ? cr > ir : cr <= ir) { h=ch; w=h*ir; } else { w=cw; h=w/ir; }
      const scale = mobile ? s.scaleMobile : s.scaleDesktop;
      w*=scale; h*=scale;
      ctx.globalAlpha = alpha;
      ctx.drawImage(im,(cw-w)/2,(ch-h)/2+ch*(mobile?s.yMobile:s.yDesktop),w,h);
    }
    draw(a,1); if (b && blend > .01) draw(b,blend);
    ctx.globalAlpha = 1;
    s.loader?.classList.add('ready');
    if (s.section.id === 'hero') document.dispatchEvent(new Event('hero-ready'));
  }
  function tick(now) {
    raf = 0;
    if (dirty) measure();
    const dt = Math.min(64, now - (previous || now - 16.67)); previous = now;
    const ease = motionPreference.matches ? 1 : 1 - Math.exp(-dt/85);
    let moving = false;
    stories.forEach(s => {
      const relative = s.top - scrollY;
      s.visible = relative < innerHeight && relative + s.height > 0;
      s.near = relative < innerHeight * 2 && relative + s.height > -innerHeight;
      s.target = clamp01(-relative / Math.max(1,s.height-s.view))*(s.count-1);
      if (!s.near) {
        s.images.forEach(im=>im.close?.()); s.images.clear();
        if (s.canvas.width > 1) { s.canvas.width=1; s.canvas.height=1; s.resize=true; }
        s.current=s.target; s.last=null; return;
      }
      s.images.forEach((im,i)=>{if(Math.abs(i-s.target)>20){im.close?.();s.images.delete(i);}});
      if (!s.visible) { s.current=s.target; return; }
      s.current += (s.target-s.current)*ease;
      if (Math.abs(s.target-s.current)<.005) s.current=s.target; else moving=true;
      const progress = s.current/(s.count-1);
      if (progress !== s.lastProgress || s.resize) {
        s.onProgress?.(progress); s.lastProgress=progress;
        // The supplied mobile layout centers panels; desktop inline transforms must not override it.
        if (innerWidth<=900) s.panels.forEach(p=>p.style.transform='translateX(-50%)');
      }
      paint(s);
    });
    pump();
    if (moving) wake();
  }
  addEventListener('scroll',wake,{passive:true});
  addEventListener('resize',()=>{dirty=true;wake();},{passive:true});
  addEventListener('load',()=>{dirty=true;wake();});
  document.addEventListener('visibilitychange',()=>{previous=0;wake();});
  motionPreference.addEventListener('change',wake);
  return {
    add(options) {
      const section=document.getElementById(options.sectionId), canvas=document.getElementById(options.canvasId);
      if(!section||!canvas)return;
      const ctx=canvas.getContext('2d',{alpha:false}); if(!ctx)return;
      stories.push({...options,section,canvas,ctx,loader:document.getElementById(options.loaderId),images:new Map(),pending:new Set(),failed:new Set(),current:0,target:0,resize:true,redraw:true,panels:[...section.querySelectorAll('.story-panel,[class*="-panel"]')]});
      dirty=true;wake();
    },
    refresh(){dirty=true;wake();}
  };
})();
function makeSequence(options){sequenceRuntime.add(options);}

const heroCopy=document.querySelector('.hero-copy'),heroHint=document.querySelector('.hero-hint'),storyLeft=document.getElementById('storyLeft'),storyRight=document.getElementById('storyRight'),storyFinal=document.getElementById('storyFinal'),finalLeft=document.getElementById('finalLeft'),finalRight=document.getElementById('finalRight');
makeSequence({sectionId:'hero',canvasId:'heroCanvas',count:107,prefix:'hero_frames/202610032017_',scaleDesktop:.84,scaleMobile:1.38,yDesktop:.065,yMobile:.025,loaderId:'heroLoader',onProgress:p=>{
 heroCopy.style.opacity=Math.max(0,1-p*4.2);heroCopy.style.transform=`translateX(-50%) translateY(${-p*40}px)`;heroHint.style.opacity=Math.max(0,1-p*7);
 const left=windowFade(p,.16,.25,.57,.68), right=windowFade(p,.24,.34,.66,.77), finalSides=windowFade(p,.70,.79,.95,1.03), fin=windowFade(p,.72,.82,.96,1.04);
 storyLeft.style.opacity=left;storyLeft.style.filter=`blur(${(1-left)*8}px)`;storyLeft.style.transform=`translate(${(-1+left)*34}px,-44%)`;
 storyRight.style.opacity=right;storyRight.style.filter=`blur(${(1-right)*8}px)`;storyRight.style.transform=`translate(${(1-right)*34}px,-44%)`;
 finalLeft.style.opacity=finalSides;finalLeft.style.filter=`blur(${(1-finalSides)*8}px)`;finalLeft.style.transform=`translate(${(-1+finalSides)*34}px,-44%)`;
 finalRight.style.opacity=finalSides;finalRight.style.filter=`blur(${(1-finalSides)*8}px)`;finalRight.style.transform=`translate(${(1-finalSides)*34}px,-44%)`;
 storyFinal.style.opacity=fin;storyFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;
}});
const impactCopy=document.getElementById('impactCopy'),badge=document.getElementById('impactBadge'),impactHint=document.querySelector('.impact-hint');makeSequence({sectionId:'impact',canvasId:'impactCanvas',count:54,prefix:'impact_frames/202610050939_',scaleDesktop:.88,scaleMobile:1.12,yDesktop:.055,yMobile:.045,loaderId:'impactLoader',onProgress:p=>{const intro=Math.max(0,Math.min(1,(.36-p)/.16));impactCopy.style.opacity=intro;impactCopy.style.transform=innerWidth<=900?'none':`translateY(calc(-50% + ${p*18}px))`;const bp=Math.max(0,Math.min(1,(p-.68)/.13));badge.style.opacity=bp;badge.style.transform=`translateY(${(1-bp)*20}px)`;impactHint.style.opacity=Math.max(0,1-p*6)}});

// Section 03 — Invisible by Design: scroll-synced installation + rotating final reveal
const clarityLeft=document.getElementById('clarityLeft'),clarityRight=document.getElementById('clarityRight'),clarityFinal=document.getElementById('clarityFinal');
const clLI=document.getElementById('clarityLeftIndex'),clLT=document.getElementById('clarityLeftTitle'),clLD=document.getElementById('clarityLeftDetail');
const clRI=document.getElementById('clarityRightIndex'),clRT=document.getElementById('clarityRightTitle'),clRD=document.getElementById('clarityRightDetail');
let clarityPhase=-1;
function setClarityCopy(phase){if(phase===clarityPhase)return;clarityPhase=phase;const phases=[
 ['01 / PRECISION ALIGNMENT','PERFECTLY<br><span>ALIGNED.</span>','ENGINEERED TO MEET EVERY EDGE','OPTICAL CLARITY / 02','SEE THE DISPLAY.<br><span>NOT THE GLASS.</span>','HIGH TRANSPARENCY · CLEAN DETAIL'],
 ['03 / AIRLESS BOND','BONDS FROM<br><span>THE CENTER.</span>','SMOOTH ADHESION · ZERO DISTRACTION','ZERO BUBBLES / 04','CLEAN CONTACT.<br><span>EDGE TO EDGE.</span>','NO GAPS · NO LIFT · NO CLOUDING'],
 ['05 / FINISHED FIT','ALMOST<br><span>INVISIBLE.</span>','ULTRA-THIN PROFILE · PRECISE CORNERS','PREMIUM FINISH / 06','MADE TO<br><span>DISAPPEAR.</span>','CLARITY YOU SEE · PROTECTION YOU DON’T'],
 ['07 / FINAL REVEAL','CRYSTAL<br><span>CLEAR.</span>','THE DISPLAY STAYS THE HERO','PRECISION FIT / 08','ONE CLEAN<br><span>FINISH.</span>','SMOOTH TOUCH · EDGE-TO-EDGE CONFIDENCE']
 ][phase];
 clLI.innerHTML=phases[0];clLT.innerHTML=phases[1];clLD.innerHTML=phases[2];clRI.innerHTML=phases[3];clRT.innerHTML=phases[4];clRD.innerHTML=phases[5];}
makeSequence({sectionId:'clarity',canvasId:'clarityCanvas',count:57,prefix:'clarity_frames/frame_',scaleDesktop:.92,scaleMobile:1.12,yDesktop:.035,yMobile:.025,loaderId:'clarityLoader',onProgress:p=>{
 const phase=p<.27?0:p<.53?1:p<.77?2:3;setClarityCopy(phase);
 const intro=clamp01(p/.08),out=clamp01((1-p)/.035),vis=Math.min(intro,out);
 clarityLeft.style.opacity=vis;clarityRight.style.opacity=vis;
 clarityLeft.style.filter=`blur(${(1-vis)*8}px)`;clarityRight.style.filter=`blur(${(1-vis)*8}px)`;
 clarityLeft.style.transform=`translate(${(-1+vis)*34}px,-44%)`;clarityRight.style.transform=`translate(${(1-vis)*34}px,-44%)`;
 const fin=clamp01((p-.80)/.10)*clamp01((1.02-p)/.05);clarityFinal.style.opacity=fin;clarityFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;
}});


// Section 04 — Choose Your Protection: four-product scroll showcase
const collectionHeading=document.getElementById('collectionHeading'),collectionLeft=document.getElementById('collectionLeft'),collectionRight=document.getElementById('collectionRight'),collectionFinal=document.getElementById('collectionFinal');
const coLI=document.getElementById('collectionLeftIndex'),coLT=document.getElementById('collectionLeftTitle'),coLD=document.getElementById('collectionLeftDetail');
const coRI=document.getElementById('collectionRightIndex'),coRT=document.getElementById('collectionRightTitle'),coRD=document.getElementById('collectionRightDetail');
let collectionPhase=-1;
function setCollectionCopy(phase){if(phase===collectionPhase)return;collectionPhase=phase;const phases=[
 ['01 / MTB','EVERYDAY<br><span>PROTECTION.</span>','HD CLARITY · SMOOTH TOUCH','MADE FOR DAILY LIFE / 01','CLEAR. STRONG.<br><span>RELIABLE.</span>','BALANCED PROTECTION · CLEAN FINISH'],
 ['02 / SUPER D','MAXIMUM<br><span>DEFENSE.</span>','ANTI-SHOCK · SCRATCH RESISTANT','BUILT TO TAKE MORE / 02','TOUGHER BY<br><span>DESIGN.</span>','REINFORCED FEEL · DAILY CONFIDENCE'],
 ['03 / PRIVACY','YOUR SCREEN.<br><span>YOUR BUSINESS.</span>','ANTI-SPY · CONTROLLED VIEW','PRIVATE FROM THE SIDE / 03','CLEAR FOR YOU.<br><span>DARK FOR THEM.</span>','PRIVACY FILTER · CLEAN VISIBILITY'],
 ['04 / MOSSILY','PREMIUM<br><span>FINISH.</span>','ULTRA CLEAR · SMOOTH TOUCH','REFINED TO THE EDGE / 04','FEELS AS GOOD<br><span>AS IT LOOKS.</span>','OPTICAL CLARITY · POLISHED FINISH']
 ][phase];[coLI.innerHTML,coLT.innerHTML,coLD.innerHTML,coRI.innerHTML,coRT.innerHTML,coRD.innerHTML]=phases;}
makeSequence({sectionId:'collection',canvasId:'collectionCanvas',count:60,prefix:'collection_frames/frame_',scaleDesktop:.90,scaleMobile:1.12,yDesktop:.025,yMobile:.015,loaderId:'collectionLoader',onProgress:p=>{
 const head=clamp01((.18-p)/.09);collectionHeading.style.opacity=head;collectionHeading.style.transform=`translateX(-50%) translateY(${(1-head)*-18}px)`;
 const phase=p<.25?0:p<.50?1:p<.75?2:3;setCollectionCopy(phase);
 const intro=clamp01((p-.08)/.08),out=clamp01((.94-p)/.08),vis=Math.min(intro,out);
 collectionLeft.style.opacity=vis;collectionRight.style.opacity=vis;collectionLeft.style.filter=`blur(${(1-vis)*8}px)`;collectionRight.style.filter=`blur(${(1-vis)*8}px)`;
 collectionLeft.style.transform=`translate(${(-1+vis)*34}px,-40%)`;collectionRight.style.transform=`translate(${(1-vis)*34}px,-40%)`;
 const fin=clamp01((p-.88)/.08);collectionFinal.style.opacity=fin;collectionFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;
}});

// Section 05 — MTB: four real product features, alternating visual/text sides
const mtbCanvas=document.getElementById('mtbCanvas'),mtbHeading=document.getElementById('mtbHeading'),mtbLeft=document.getElementById('mtbLeft'),mtbRight=document.getElementById('mtbRight'),mtbSpecs=document.getElementById('mtbSpecs'),mtbFinal=document.getElementById('mtbFinal');
const mtbLI=document.getElementById('mtbLeftIndex'),mtbLT=document.getElementById('mtbLeftTitle'),mtbLD=document.getElementById('mtbLeftDetail'),mtbLDesc=document.getElementById('mtbLeftDesc');
const mtbRI=document.getElementById('mtbRightIndex'),mtbRT=document.getElementById('mtbRightTitle'),mtbRD=document.getElementById('mtbRightDetail'),mtbRDesc=document.getElementById('mtbRightDesc');
let mtbPhase=-1;
function setMtbCopy(phase){if(phase===mtbPhase)return;mtbPhase=phase;
 const data=[
  ['01 / EDGE-TO-EDGE','COVERAGE TO<br><span>EVERY EDGE.</span>','FULL COVER · PRECISE FIT · FULL GLUE','A clean full-screen fit designed to follow the display closely from edge to edge.'],
  ['02 / RESPONSIVE TOUCH','TOUCH IN.<br><span>ACTION OUT.</span>','SMOOTH TOUCH · FAST RESPONSE','A smooth touch surface keeps taps, swipes and fast gameplay feeling direct and controlled.'],
  ['03 / HIGH TRANSPARENCY','SEE THE SCREEN.<br><span>NOT THE GLASS.</span>','HD+ CLEAR · HIGH TRANSPARENCY','High transparency keeps fine detail crisp while the protector visually disappears over the display.'],
  ['04 / EASY TO CLEAN','CLEANER BY<br><span>DESIGN.</span>','HYDROPHOBIC · ANTI-FINGERPRINT','A wear-resistant hydrophobic surface helps water bead away and everyday smudges clean more easily.']
 ][phase];
 const leftSide=phase<2;
 const I=leftSide?mtbLI:mtbRI,T=leftSide?mtbLT:mtbRT,D=leftSide?mtbLD:mtbRD,X=leftSide?mtbLDesc:mtbRDesc;
 I.innerHTML=data[0];T.innerHTML=data[1];D.innerHTML=data[2];X.innerHTML=data[3];
}
makeSequence({sectionId:'mtb',canvasId:'mtbCanvas',count:60,prefix:'mtb_frames/frame_',scaleDesktop:.91,scaleMobile:1.12,yDesktop:.035,yMobile:.02,loaderId:'mtbLoader',onProgress:p=>{
 const head=clamp01((.13-p)/.07);mtbHeading.style.opacity=head;mtbHeading.style.transform=`translateX(-50%) translateY(${(1-head)*-18}px)`;
 const phase=p<.25?0:p<.50?1:p<.75?2:3;setMtbCopy(phase);
 const stageIn=clamp01((p-.07)/.06),stageOut=clamp01((.94-p)/.06),vis=Math.min(stageIn,stageOut);
 const firstHalf=p<.5;
 mtbLeft.style.opacity=firstHalf?vis:0;mtbRight.style.opacity=firstHalf?0:vis;
 mtbLeft.style.filter=`blur(${(1-(firstHalf?vis:0))*8}px)`;mtbRight.style.filter=`blur(${(1-(!firstHalf?vis:0))*8}px)`;
 mtbLeft.style.transform=`translate(${(-1+(firstHalf?vis:0))*34}px,-42%)`;mtbRight.style.transform=`translate(${(1-(!firstHalf?vis:0))*34}px,-42%)`;
 // first two visuals live right; final two move left, leaving the opposite side for copy
 const side=p<.46?1:p>.54?-1:1-((p-.46)/.08)*2;
 mtbCanvas.style.transform=`translateX(${side*(innerWidth<=900?8:13)}vw)`;
 const specs=clamp01((p-.10)/.08)*clamp01((.86-p)/.10);mtbSpecs.style.opacity=specs;
 const fin=clamp01((p-.88)/.08);mtbFinal.style.opacity=fin;mtbFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;
 if(fin>.05){mtbSpecs.style.opacity=0;mtbLeft.style.opacity=0;mtbRight.style.opacity=0;mtbCanvas.style.transform='translateX(0)'}
}});


// Section 06 — SUPER D: thick glue, key test, full defense
const sdHead=document.getElementById('superdHeading'),sdL=document.getElementById('superdLeft'),sdR=document.getElementById('superdRight'),sdSpecs=document.getElementById('superdSpecs'),sdFinal=document.getElementById('superdFinal');
const sdLI=document.getElementById('superdLeftIndex'),sdLT=document.getElementById('superdLeftTitle'),sdLD=document.getElementById('superdLeftDetail'),sdLX=document.getElementById('superdLeftDesc');
const sdRI=document.getElementById('superdRightIndex'),sdRT=document.getElementById('superdRightTitle'),sdRD=document.getElementById('superdRightDetail'),sdRX=document.getElementById('superdRightDesc');
let sdPhase=-1;function setSdCopy(ph){if(ph===sdPhase)return;sdPhase=ph;
 const data=ph===0?['01 / THICK GLUE','A DEEPER BOND.<br><span>BUILT TO HOLD.</span>','THICK FULL-SURFACE ADHESIVE','A substantial clear adhesive layer settles across the display for a secure, complete bond.']:
 ph===1?['02 / SCRATCH RESISTANT','KEYS MAKE CONTACT.<br><span>CLARITY STAYS.</span>','REAL-WORLD SURFACE DEFENSE','A direct key test puts the surface to work while the protector stays visibly clean and clear.']:
 ['03 / MAXIMUM DEFENSE','FULLY BONDED.<br><span>FULLY COVERED.</span>','REINFORCED FRONT-SCREEN PROTECTION','The protector finishes flush to the display, with secure coverage across the full front surface.'];
 const left=ph===1,I=left?sdLI:sdRI,T=left?sdLT:sdRT,D=left?sdLD:sdRD,X=left?sdLX:sdRX;I.textContent=data[0];T.innerHTML=data[1];D.textContent=data[2];X.textContent=data[3];}
makeSequence({sectionId:'superd',canvasId:'superdCanvas',count:80,prefix:'superd_frames/frame_',scaleDesktop:.90,scaleMobile:1.12,yDesktop:.02,yMobile:.015,loaderId:'superdLoader',onProgress:p=>{
 const head=clamp01((.10-p)/.055);sdHead.style.opacity=head;sdHead.style.transform=`translateX(-50%) translateY(${(1-head)*-16}px)`;
 let ph=p<.34?0:p<.66?1:2;setSdCopy(ph);
 const local=ph===0?clamp01((p-.09)/.07)*clamp01((.37-p)/.07):ph===1?clamp01((p-.35)/.07)*clamp01((.67-p)/.07):clamp01((p-.65)/.07)*clamp01((.91-p)/.08);
 const left=ph===1;sdL.style.opacity=left?local:0;sdR.style.opacity=left?0:local;sdL.style.filter=`blur(${(1-(left?local:0))*8}px)`;sdR.style.filter=`blur(${(1-(!left?local:0))*8}px)`;sdL.style.transform=`translate(${(-1+(left?local:0))*34}px,-42%)`;sdR.style.transform=`translate(${(1-(!left?local:0))*34}px,-42%)`;
 const side=ph===1?1:-1;document.getElementById('superdCanvas').style.transform=`translateX(${side*(innerWidth<=900?5:9)}vw)`;
 const specs=clamp01((p-.12)/.08)*clamp01((.88-p)/.09);sdSpecs.style.opacity=specs;
 const fin=clamp01((p-.91)/.06);sdFinal.style.opacity=fin;sdFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;if(fin>.05){sdL.style.opacity=0;sdR.style.opacity=0;sdSpecs.style.opacity=0;document.getElementById('superdCanvas').style.transform='translateX(0)'}
}});



// Section 08 — final uploaded frame sequence; previous sections remain untouched
const lsHead=document.getElementById('lastHeading'),lsL=document.getElementById('lastLeft'),lsR=document.getElementById('lastRight'),lsSpecs=document.getElementById('lastSpecs'),lsFinal=document.getElementById('lastFinal');
const lsLI=document.getElementById('lastLeftIndex'),lsLT=document.getElementById('lastLeftTitle'),lsLD=document.getElementById('lastLeftDetail'),lsLX=document.getElementById('lastLeftDesc');
const lsRI=document.getElementById('lastRightIndex'),lsRT=document.getElementById('lastRightTitle'),lsRD=document.getElementById('lastRightDetail'),lsRX=document.getElementById('lastRightDesc');
let lsPhase=-1;function setLastCopy(ph){if(ph===lsPhase)return;lsPhase=ph;const data=[
 ['01 / PREMIUM FINISH','MADE TO LOOK<br><span>SEAMLESS.</span>','CLEAN FIT · REFINED GLASS','A polished protector designed to sit naturally over the display without taking attention away from the phone.'],
 ['02 / OPTICAL CLARITY','KEEP THE DETAIL.<br><span>LOSE THE DISTRACTION.</span>','CLEAR VIEW · NATURAL COLOR','A transparent finish keeps the display crisp and lets the screen remain the visual focus.'],
 ['03 / SMOOTH TOUCH','TAP. SWIPE.<br><span>STAY RESPONSIVE.</span>','NATURAL TOUCH RESPONSE','The protected surface stays smooth and direct for everyday taps, scrolling and gestures.'],
 ['04 / EVERYDAY READY','PROTECTION THAT<br><span>FITS YOUR DAY.</span>','CLEAN · REFINED · READY','A premium final layer of protection designed to feel integrated with the phone from every angle.']
 ][ph];const left=ph%2===0,I=left?lsLI:lsRI,T=left?lsLT:lsRT,D=left?lsLD:lsRD,X=left?lsLX:lsRX;I.textContent=data[0];T.innerHTML=data[1];D.textContent=data[2];X.textContent=data[3];}
makeSequence({sectionId:'lastfeature',canvasId:'lastCanvas',count:49,prefix:'last_frames/frame_',scaleDesktop:.92,scaleMobile:1.12,yDesktop:.02,yMobile:.015,loaderId:'lastLoader',onProgress:p=>{
 const head=clamp01((.14-p)/.075);lsHead.style.opacity=head;lsHead.style.transform=`translateX(-50%) translateY(${(1-head)*-16}px)`;
 const ph=p<.27?0:p<.52?1:p<.77?2:3;setLastCopy(ph);
 const starts=[.10,.29,.54,.79],ends=[.30,.55,.80,.94];const local=clamp01((p-starts[ph])/.06)*clamp01((ends[ph]-p)/.055),left=ph%2===0;
 lsL.style.opacity=left?local:0;lsR.style.opacity=left?0:local;lsL.style.filter=`blur(${(1-(left?local:0))*8}px)`;lsR.style.filter=`blur(${(1-(!left?local:0))*8}px)`;lsL.style.transform=`translate(${(-1+(left?local:0))*34}px,-42%)`;lsR.style.transform=`translate(${(1-(!left?local:0))*34}px,-42%)`;
 const specs=clamp01((p-.12)/.08)*clamp01((.88-p)/.09);lsSpecs.style.opacity=specs;
 const fin=clamp01((p-.92)/.055);lsFinal.style.opacity=fin;lsFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;if(fin>.05){lsL.style.opacity=0;lsR.style.opacity=0;lsSpecs.style.opacity=0}
}});

// Section 08 — Mossily variants: Clear → UV → Borderless → Privacy
const moHead=document.getElementById('mossilyHeading'),moL=document.getElementById('mossilyLeft'),moR=document.getElementById('mossilyRight'),moSpecs=document.getElementById('mossilySpecs'),moFinal=document.getElementById('mossilyFinal');
const moLI=document.getElementById('mossilyLeftIndex'),moLT=document.getElementById('mossilyLeftTitle'),moLD=document.getElementById('mossilyLeftDetail'),moLX=document.getElementById('mossilyLeftDesc');
const moRI=document.getElementById('mossilyRightIndex'),moRT=document.getElementById('mossilyRightTitle'),moRD=document.getElementById('mossilyRightDetail'),moRX=document.getElementById('mossilyRightDesc');
let moPhase=-1;function setMossilyCopy(ph){if(ph===moPhase)return;moPhase=ph;const data=[
 ['01 / CLEAR','CRYSTAL CLEAR.<br><span>NOTHING IN THE WAY.</span>','HIGH TRANSPARENCY · NATURAL VIEW','A clean transparent finish designed to preserve the original look of the display.'],
 ['02 / UV','PRECISION BOND.<br><span>REFINED FINISH.</span>','UV BONDING · FULL-SURFACE FIT','A UV-assisted bonding option for a precise, polished fit across the protected surface.'],
 ['03 / BORDERLESS','EDGE TO EDGE.<br><span>VISUALLY SEAMLESS.</span>','MINIMAL BORDER · CLEAN COVERAGE','A refined borderless profile keeps the perimeter minimal for a cleaner full-screen look.'],
 ['04 / PRIVACY','CLEAR FOR YOU.<br><span>PRIVATE FROM THE SIDE.</span>','ANTI-SPY · SIDE-VIEW DARKENING','A darker privacy filter helps keep on-screen content difficult to read from side viewing angles.']
 ][ph];const left=ph%2===0,I=left?moLI:moRI,T=left?moLT:moRT,D=left?moLD:moRD,X=left?moLX:moRX;I.textContent=data[0];T.innerHTML=data[1];D.textContent=data[2];X.textContent=data[3];}
makeSequence({sectionId:'mossily',canvasId:'mossilyCanvas',count:62,prefix:'mossily_frames/frame_',scaleDesktop:.90,scaleMobile:1.12,yDesktop:.025,yMobile:.02,loaderId:'mossilyLoader',onProgress:p=>{
 const head=clamp01((.15-p)/.075);moHead.style.opacity=head;moHead.style.transform=`translateX(-50%) translateY(${(1-head)*-16}px)`;
 const ph=p<.25?0:p<.50?1:p<.75?2:3;setMossilyCopy(ph);const starts=[.11,.29,.54,.79],ends=[.30,.55,.80,.94];const local=clamp01((p-starts[ph])/.06)*clamp01((ends[ph]-p)/.055),left=ph%2===0;
 moL.style.opacity=left?local:0;moR.style.opacity=left?0:local;moL.style.filter=`blur(${(1-(left?local:0))*8}px)`;moR.style.filter=`blur(${(1-(!left?local:0))*8}px)`;moL.style.transform=`translate(${(-1+(left?local:0))*34}px,-42%)`;moR.style.transform=`translate(${(1-(!left?local:0))*34}px,-42%)`;
 const specs=clamp01((p-.10)/.08)*clamp01((.89-p)/.08);moSpecs.style.opacity=specs;const fin=clamp01((p-.92)/.055);moFinal.style.opacity=fin;moFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;if(fin>.05){moL.style.opacity=0;moR.style.opacity=0;moSpecs.style.opacity=0}
}});

// Section 09 — DIY installation; full-width frame sequence
const inHead=document.getElementById('installHeading'),inL=document.getElementById('installLeft'),inR=document.getElementById('installRight'),inSpecs=document.getElementById('installSpecs'),inFinal=document.getElementById('installFinal');
const inLI=document.getElementById('installLeftIndex'),inLT=document.getElementById('installLeftTitle'),inLD=document.getElementById('installLeftDetail'),inLX=document.getElementById('installLeftDesc');
const inRI=document.getElementById('installRightIndex'),inRT=document.getElementById('installRightTitle'),inRD=document.getElementById('installRightDetail'),inRX=document.getElementById('installRightDesc');
let inPhase=-1;function setInstallCopy(ph){if(ph===inPhase)return;inPhase=ph;const data=[
 ['01 / ALIGN','LINE IT UP.<br><span>KEEP IT SIMPLE.</span>','PRECISE EDGE-TO-EDGE ALIGNMENT','Hold the protector by the edges and line it up cleanly with the display.'],
 ['02 / PLACE','LOWER GENTLY.<br><span>LET IT SETTLE.</span>','CONTROLLED · EASY · ACCURATE','Once aligned, lower the glass smoothly onto the screen without complicated tools.'],
 ['03 / BOND','TOUCH DOWN.<br><span>WATCH IT BOND.</span>','FULL-SURFACE ADHESIVE CONTACT','The protector settles across the display as the bond spreads cleanly toward every edge.'],
 ['04 / DONE','NO SHOP.<br><span>NO TECHNICIAN.</span>','CLEAN FIT · READY TO USE','A simple at-home installation leaves the glass aligned, bonded and ready for everyday use.']
][ph];const left=ph%2===0,I=left?inLI:inRI,T=left?inLT:inRT,D=left?inLD:inRD,X=left?inLX:inRX;I.textContent=data[0];T.innerHTML=data[1];D.textContent=data[2];X.textContent=data[3];}
makeSequence({sectionId:'install',canvasId:'installCanvas',count:74,prefix:'install_frames/frame_',scaleDesktop:1.0,scaleMobile:1.10,yDesktop:0,yMobile:0,loaderId:'installLoader',onProgress:p=>{
 const head=clamp01((.15-p)/.075);inHead.style.opacity=head;inHead.style.transform=`translateX(-50%) translateY(${(1-head)*-16}px)`;
 const ph=p<.25?0:p<.50?1:p<.75?2:3;setInstallCopy(ph);const starts=[.11,.29,.54,.79],ends=[.30,.55,.80,.94];const local=clamp01((p-starts[ph])/.06)*clamp01((ends[ph]-p)/.055),left=ph%2===0;
 inL.style.opacity=left?local:0;inR.style.opacity=left?0:local;inL.style.filter=`blur(${(1-(left?local:0))*8}px)`;inR.style.filter=`blur(${(1-(!left?local:0))*8}px)`;inL.style.transform=`translate(${(-1+(left?local:0))*34}px,-42%)`;inR.style.transform=`translate(${(1-(!left?local:0))*34}px,-42%)`;
 const specs=clamp01((p-.10)/.08)*clamp01((.89-p)/.08);inSpecs.style.opacity=specs;const fin=clamp01((p-.92)/.055);inFinal.style.opacity=fin;inFinal.style.transform=`translate(-50%,${(1-fin)*18}px)`;if(fin>.05){inL.style.opacity=0;inR.style.opacity=0;inSpecs.style.opacity=0}
}});

// Reveal as soon as a hero frame is painted, with a bounded error fallback.
(() => {
 const el=document.getElementById('pageLoader');if(!el)return;
 let closed=false;
 const close=()=>{if(closed)return;closed=true;el.classList.add('done');document.body.classList.remove('loading-page');setTimeout(()=>el.remove(),700);};
 document.addEventListener('hero-ready',close,{once:true});
 setTimeout(close,4500);
})();

// ===== WHATSAPP EXPERIENCE =====
(() => {
  const phone = "94759902703";
  const wa = (text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  const generic = "Hi GlassGuard! I need help finding the correct tempered glass for my phone.";

  const float = document.getElementById("ggWaFloat");
  if(float) float.href = wa(generic);
  document.querySelectorAll("[data-wa-generic]").forEach(a => a.href = wa(generic));

  // Existing navbar WhatsApp CTA: use the real number.
  const navWa = document.querySelector(".wa-order");
  if(navWa){ navWa.href=wa(generic); navWa.target="_blank"; navWa.rel="noopener"; }

  document.querySelectorAll("[data-wa-generic],#ggWaFloat").forEach(a=>{
    a.target="_blank"; a.rel="noopener";
  });

  const bubble=document.getElementById("ggWaBubble");
  const close=document.querySelector(".gg-wa-close");
  let bubbleTimer=setTimeout(()=>{if(scrollY<60)bubble?.classList.add("show");},2800);
  let hideTimer=setTimeout(()=>bubble?.classList.remove("show"),10500);
  addEventListener('scroll',()=>{if(scrollY>60){clearTimeout(bubbleTimer);bubble?.classList.remove('show');}},{passive:true});
  close?.addEventListener("click",()=>{
    clearTimeout(bubbleTimer);clearTimeout(hideTimer);bubble.classList.remove("show");
  });
})();

// Fine wheel easing while keeping touch, keyboard, nested controls and zoom native.
(() => {
  let frame=0, target=scrollY, last=0, expected=scrollY;
  const stop=()=>{cancelAnimationFrame(frame);frame=0;last=0;target=scrollY;document.documentElement.classList.remove('wheel-easing');};
  function tick(now){
    const dt=Math.min(64,now-(last||now-16.67));last=now;
    const next=scrollY+(target-scrollY)*(1-Math.exp(-dt/95));
    window.scrollTo({top:Math.abs(target-next)<1.1?target:next,behavior:'instant'});
    expected=scrollY;
    if(Math.abs(target-scrollY)>1)frame=requestAnimationFrame(tick);else stop();
  }
  addEventListener('wheel',e=>{
    if(motionPreference.matches||e.ctrlKey||e.metaKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)||e.defaultPrevented)return;
    let node=e.target instanceof Element?e.target:null;
    while(node&&node!==document.body){
      if(node.matches('input,textarea,select,[contenteditable="true"]'))return;
      const style=getComputedStyle(node);
      if(/auto|scroll/.test(style.overflowY)&&node.scrollHeight>node.clientHeight+1)return;
      node=node.parentElement;
    }
    if(!e.cancelable)return;
    e.preventDefault();
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);
    if(!frame)target=scrollY;
    const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);
    target=Math.round(Math.max(0,Math.min(max,scrollY+Math.max(-innerHeight*1.5,Math.min(innerHeight*1.5,target-scrollY+delta)))));
    expected=scrollY;
    document.documentElement.classList.add('wheel-easing');
    if(!frame)frame=requestAnimationFrame(tick);
  },{passive:false});
  ['touchstart','pointerdown','keydown'].forEach(type=>addEventListener(type,stop,{passive:true}));
  addEventListener('scroll',()=>{if(frame&&Math.abs(scrollY-expected)>2)stop();},{passive:true});
  document.addEventListener('click',e=>{if(e.target.closest('a[href^="#"]'))stop();});
  motionPreference.addEventListener('change',stop);
  document.addEventListener('visibilitychange',stop);
})();

(() => {
  const header=document.querySelector('header'),menu=document.querySelector('.menu-toggle'),nav=document.getElementById('primaryNav');
  const close=()=>{header.classList.remove('menu-open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Open navigation');};
  menu.addEventListener('click',()=>{
    const open=menu.getAttribute('aria-expanded')!=='true';
    header.classList.toggle('menu-open',open);menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');
  });
  document.addEventListener('click',e=>{if(!header.contains(e.target)||e.target.closest('nav a'))close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&header.classList.contains('menu-open')){close();menu.focus();}});
  matchMedia('(min-width: 1101px)').addEventListener('change',close);
  const links=[...nav.querySelectorAll('a')];
  const sections=[...document.querySelectorAll('section[id]')];
  const groups={hero:'hero',impact:'impact',clarity:'clarity',collection:'collection',mtb:'collection',superd:'collection',lastfeature:'collection',mossily:'collection',install:'install',finder:'finder'};
  let queued=false;
  function update(){
    queued=false; header.classList.toggle('scrolled',scrollY>24);
    let id='hero';
    for(const section of sections){if(section.getBoundingClientRect().top<=innerHeight*.35)id=groups[section.id]||id;}
    for(const a of links){const active=a.hash==='#'+id;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');}
  }
  addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(update);}},{passive:true});
  addEventListener('resize',update);update();
})();

// Resize the embedded finder when its results change, without a growing iframe feedback loop.
(() => {
  const frame=document.getElementById('finderFrame');let observer;
  function connect(){
    try{
      observer?.disconnect();
      const content=frame.contentDocument?.querySelector('body > section');if(!content)return;
      frame.contentDocument.body.classList.add('embedded-finder');
      const fit=()=>{const height=Math.ceil(content.getBoundingClientRect().height);if(height&&Math.abs(frame.offsetHeight-height)>1){frame.style.height=height+'px';sequenceRuntime.refresh();}};
      observer=new ResizeObserver(fit);observer.observe(content);fit();
    }catch(_){/* Opening index.html directly can isolate the iframe; its default height remains usable. */}
  }
  frame.addEventListener('load',connect);connect();
})();
