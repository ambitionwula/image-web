import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ImageMaskEditor from './ImageMaskEditor'
import EcommercePlanner from './EcommercePlanner'
import ChatPanel from './ChatPanel'
import { AccountModal, AuthScreen, OrderManagementModal, UserManagementModal } from './AuthViews'
import SizeSelector, { EDIT_SIZE_OPTIONS, normalizeEditSize, normalizeStandardSize, STANDARD_SIZE_OPTIONS } from './SizeSelector'
import { fitGptImage2OutputSize } from './imageSizing'
import { formatImageBytes, optimizeImageForGpt } from './imageProcessing'
import './styles.css'

const defaults = {
  baseUrl: 'https://newapi.smartlifemarketing.com/v1', apiKey: '', model: 'gpt-image-2', copyModel: 'gpt-5.6-sol', chatModel: 'gpt-5.5',
  size: '1024x1024', quality: 'standard', format: 'url', autoSave: false, saveDirectory: '', imagePointCost: 3, copyPointCost: 1, rechargeRate: 10,
  membershipLevel: 'normal', membershipLabel: '普通用户', normalImagePrice: 0.3, normalCopyPrice: 0.1, vipImagePrice: 0.2, vipCopyPrice: 0.08,
  vipDescription: '适合稳定创作用户，图片与文案生成享受更低单价。', svipImagePrice: 0.1, svipCopyPrice: 0.05,
  svipDescription: '适合高频创作团队，享受最低图片和文案生成单价。', vipOpenPrice: 29, svipOpenPrice: 99,
  paymentEnabled: false, paymentConfigured: false, paymentGatewayUrl: '', paymentCallbackBaseUrl: '', paymentReturnUrl: '', paymentMerchantId: '',
  paymentMerchantKey: '', hasPaymentMerchantKey: false, paymentMerchantKeyHint: '', paymentMinAmount: 1,
  checkInRewardPoints: 10, checkInWindowDays: 30,
}

const defaultBilling = { imageCount: 0, copyCount: 0 }
const disclaimerVersion = '2026-08-06-v2'
const disclaimerStorageKey = 'image-studio-disclaimer-acceptance'
const generationConcurrency = 2
const commerceRequestSpacing = 20000
const commerceFinalRetryDelays = [15000, 30000]
const toolGenerationCounts = [1, 2]
const generationQualityOptions = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'low', label: '低 · 快速草稿' },
  { value: 'medium', label: '中 · 标准创作' },
  { value: 'high', label: '高 · 精细成图' },
]

function normalizeGenerationQuality(value) {
  if (generationQualityOptions.some(option => option.value === value)) return value
  if (value === 'hd') return 'high'
  return 'auto'
}

function normalizeToolGenerationCount(value) {
  return Number(value) === 2 ? 2 : 1
}

function uniqueModelOptions(...groups) {
  return [...new Set(groups.flat().map(value => (value || '').toString().trim()).filter(Boolean))]
}

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

function isRetryableTimeout(message = '') {
  return /\b(429|500|502|503|504|524)\b|timeout|time-out|timed out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|gateway/i.test(message)
}

const Icon = ({ children }) => <span className="icon">{children}</span>

function submitPaymentForm(gatewayUrl, form) {
  const formElement = document.createElement('form')
  formElement.method = 'POST'
  formElement.action = gatewayUrl
  formElement.target = '_blank'
  Object.entries(form || {}).forEach(([key, value]) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = key
    input.value = value == null ? '' : String(value)
    formElement.appendChild(input)
  })
  document.body.appendChild(formElement)
  formElement.submit()
  formElement.remove()
}

function hasAcceptedDisclaimer() {
  try {
    const acceptance = JSON.parse(localStorage.getItem(disclaimerStorageKey) || '{}')
    return acceptance.accepted === true && acceptance.version === disclaimerVersion
  } catch {
    return false
  }
}

function DisclaimerModal({ required, onAccept, onClose }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="modal-backdrop disclaimer-backdrop" role="presentation" onMouseDown={event => {
    if (!required && event.target === event.currentTarget) onClose()
  }}>
    <div className={`modal disclaimer-modal${expanded ? ' is-expanded' : ''}`} role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <div className="modal-head disclaimer-head">
        <div><span>{required ? 'FIRST USE CONFIRMATION' : 'TERMS & NOTICE'}</span><h2 id="disclaimer-title">{required ? '开始使用前，请确认协议' : '使用协议'}</h2></div>
        {!required && <button type="button" aria-label="关闭免责声明" onClick={onClose}>×</button>}
      </div>

      <p className="disclaimer-lead">{required ? '首次使用需要同意以下协议。你可以展开查看完整内容。' : '协议内容可展开查看，关闭后不会影响已保存的同意状态。'}</p>

      <button type="button" className="disclaimer-toggle" aria-expanded={expanded} aria-controls="disclaimer-details" onClick={() => setExpanded(value => !value)}>
        <span className="disclaimer-toggle-icon">§</span>
        <span className="disclaimer-toggle-copy"><b>AI生成内容使用协议与免责声明</b><small>更新日期：2026年8月6日 · 版本 1.1</small></span>
        <em>{expanded ? '收起' : '查看全文'}</em>
        <i aria-hidden="true">⌄</i>
      </button>

      {expanded && <div className="disclaimer-details" id="disclaimer-details">
        <div className="disclaimer-summary"><b>使用前请特别注意</b><p>AI生成结果可能不准确，不等同于真实商品、专业意见或权利保证。用于电商、广告和其他商业场景前，必须由用户人工审核。</p></div>

        <div className="disclaimer-content">
        <section><h3>一、协议范围与服务性质</h3><p>本软件及其开发者、运营者（以下合称“服务方”）提供本地图片生成、图片编辑、电商策划和相关辅助工具。软件根据用户输入的提示词、上传素材以及用户配置的第三方人工智能模型和接口生成内容。人工智能输出具有概率性，服务方不保证生成结果完全准确、真实、完整、唯一、持续可用或符合用户的特定用途。</p></section>

        <section><h3>二、上传素材与权利保证</h3><p>用户应确保对上传或输入的商品图片、商标、Logo、文字、字体、人物肖像、声音、作品及其他素材拥有合法权利，或者已经取得必要授权。用户不得上传国家秘密、商业秘密、敏感个人信息以及无权处理的第三方资料。因用户上传、输入或使用相关素材引起的知识产权、肖像权、隐私权、个人信息保护或其他争议，由用户依法承担相应责任。</p></section>

        <section><h3>三、生成结果的人工审核义务</h3><p>生成内容可能出现商品变形、Logo或文字错误、颜色偏差、人物失真、事实错误，以及对材质、尺寸、参数、功效、认证、价格和使用场景的不准确描述。用户在下载、发布、传播、印刷、销售或商业使用前，应核对原始资料和真实商品，并完成必要的人工审核、修改和合规确认。软件中的分析、标题、卖点和文案仅为创意辅助，不构成事实证明、质量承诺、检测结论、医疗建议、法律意见、投资建议或其他专业意见。</p></section>

        <section><h3>四、电商、广告与商业使用</h3><p>用户不得使用生成内容虚构商品功能、材质、规格、产地、销量、荣誉、认证、功效或用户评价，不得以生成图冒充真实拍摄图误导消费者。即使图片带有“AI生成”“仅供参考”或“以实物为准”等提示，用户仍应确保最终发布内容真实、清楚、合法，并与实际商品和正式销售资料一致。商业发布所需的平台审核、广告审查、授权证明和消费者告知义务，由发布者自行完成。</p></section>

        <section><h3>五、禁止用途</h3><p>用户不得利用本软件制作或传播违法违规、侵权、欺诈、虚假宣传、冒充他人、诽谤侮辱、色情暴力、仇恨歧视、危害未成年人、干扰公共秩序或可能造成他人损害的内容，也不得绕过安全措施、攻击接口、盗用密钥或将软件用于未经授权的自动化服务。</p></section>

        <section><h3>六、AI生成标识</h3><p>用户应根据适用法律法规、发布平台规则及实际使用场景，为生成或合成内容添加并保留必要的人工智能生成标识，不得恶意删除、篡改或隐匿依法应当保留的标识。软件提供的标识或提示仅为辅助，用户仍应自行判断具体发布场景的标识要求。</p></section>

        <section><h3>七、数据处理与第三方服务</h3><p>本软件的设置和使用记录主要保存在当前设备。为了完成生成、编辑、分析或对话，用户上传的图片、提示词及必要请求参数会通过本地服务发送至用户配置的第三方接口或模型服务商。第三方服务的处理规则、保存期限、可用性和安全措施由相应第三方负责。用户在使用前应阅读第三方规则，不应提交无需处理的敏感信息。API Key属于用户的重要凭证，用户应妥善保管并承担因泄露、共享或配置错误造成的风险。</p></section>

        <section><h3>八、服务中断与责任限制</h3><p>第三方模型可能发生排队、限流、超时、内容拒绝、接口变更或服务中断。服务方会在合理范围内维护软件，但不承诺服务永久无错误或不中断。在法律允许的最大范围内，对于因AI模型固有不确定性、第三方接口故障、用户未经审核直接使用结果、用户违法使用或用户提供错误素材而产生的间接损失、预期利益损失或商誉损失，服务方不承担责任。</p><p>前述约定不免除或限制依法不得免除或限制的责任，包括服务方因故意、重大过失、造成人身损害或违反法定义务而应承担的责任。</p></section>

        <section><h3>九、投诉处理与协议更新</h3><p>服务方有权对涉嫌违法、侵权或滥用的内容采取停止处理、限制功能、保存必要记录或配合主管部门调查等措施。用户发现侵权或安全问题时，应提供能够识别相关内容和权利基础的材料。免责声明发生实质更新后，软件会要求用户重新阅读并确认；不同意更新内容的用户应停止使用软件。</p></section>

        <section><h3>十、用户账户、设备及凭证安全</h3><p>用户应通过合法、真实、有效的方式使用本软件，不得冒用他人身份、伪造授权关系，或使用来源不明的账户、接口凭证和模型服务。</p><p>用户应妥善保管账户密码、API Key、访问令牌、设备权限及其他身份验证信息，不得以出售、出借、转让、公开发布、上传至公开代码仓库或其他方式向无关第三方披露。因用户保管不善、配置错误、授权范围过大、使用不安全的第三方插件或主动向他人提供凭证而造成的调用、费用、数据泄露、内容生成或其他损失，由用户依法承担相应责任。</p><p>用户发现账户、API Key或其他凭证存在泄露、盗用、异常调用或未经授权使用情形的，应立即停止使用并采取撤销、重置、删除或更换等措施。服务方有权在合理必要范围内暂停相关功能、限制调用或要求用户重新验证身份。</p><p>除法律明确允许或经服务方书面授权外，用户不得：（1）绕过、破解、干扰或破坏软件的访问控制、计费、限流或安全措施；（2）反向工程、反编译、反汇编或试图获取软件源代码、模型权重或未公开接口；（3）批量注册账户、恶意占用计算资源或利用自动化程序制造异常请求；（4）未经授权抓取、复制、转售或再包装软件及其服务能力；（5）利用软件测试、探测或攻击第三方模型、接口、平台或网络系统。</p></section>

        <section><h3>十一、生成内容、上传内容及知识产权</h3><p>“上传内容”是指用户上传、输入、提交或以其他方式提供的图片、文字、商标、Logo、字体、音频、视频、人物形象、商品资料及其他素材；“生成内容”是指软件根据用户的提示词、上传内容、参数或配置，由本软件或第三方模型生成、编辑、分析或整理的文字、图片、音频、视频、方案、标题、文案及其他结果。</p><p>用户仍保留其对上传内容依法享有的权利。为实现生成、编辑、分析、存储、传输、故障排查、安全审查和客户支持，用户授予服务方及必要技术服务商一项非独占、有限、全球范围内且仅为提供和改进本软件服务所必要的使用许可。除取得用户另行授权或法律另有要求外，服务方不得将上传内容直接公开展示、出售、许可给无关第三方或用于与用户无关的商业宣传。</p><p>生成内容可能与其他内容相同或近似。服务方不保证生成内容具有唯一性、独创性、可登记性、能够获得知识产权保护或不侵犯第三方权利。不同国家或地区对AI生成内容的认定可能不同，生成内容是否构成作品、权利归属及保护范围，以适用法律和有权机关认定为准。</p><p>用户还应遵守第三方模型或接口服务商对输入、输出和商业使用设置的限制。未经相应权利人授权，用户不得要求服务方去除水印、版权声明、授权标识、数字水印或其他权利管理信息。</p></section>

        <section><h3>十二、第三方模型及接口服务</h3><p>本软件可能支持用户自行配置或调用第三方人工智能模型、云服务、图像处理、翻译、存储、支付或其他外部服务。第三方服务由相应服务商独立提供，可能发生服务条款调整、价格变化、模型升级、接口变更、地区限制、数据政策变化、内容拒绝、限流、暂停或终止。</p><p>用户使用第三方服务前，应自行阅读并遵守其服务条款、隐私政策、内容政策、知识产权政策和商业使用规则。用户应自行承担其配置的第三方接口产生的模型调用费、存储费、网络流量费、超额费用及其他费用；除因服务方故意或重大过失造成的错误扣费外，服务方不对第三方计费结果承担责任。</p><p>用户提交给第三方的内容可能由第三方按照其规则进行传输、处理、存储、审核或安全分析。用户不得将国家秘密、未公开的重大商业秘密、未经授权的个人信息、支付信息、医疗信息、未成年人敏感信息或其他高风险数据提交给未经充分核验的第三方模型或接口。</p></section>

        <section><h3>十三、数据处理、保存和删除</h3><p>服务方仅在提供功能、处理请求、保障安全、处理投诉、履行法定义务及改进服务所必要的范围内处理数据。根据用户实际使用的功能，可能处理提示词、指令、对话、上传或生成的文件、模型和接口配置、任务记录、设备与软件信息、网络和错误日志，以及用于安全、计费、风控、投诉和合规留痕的必要记录。</p><p>服务方将根据适用法律采取合理的技术和管理措施，但任何互联网传输、云端处理、第三方接口调用和本地存储均不能保证绝对安全。用户应遵循合法、正当、必要、透明和最小化原则，避免提交与处理目的无关的个人信息；涉及敏感个人信息、未成年人信息或其他特别保护数据时，应确保具有合法处理基础并履行必要的告知、授权和风险评估义务。</p><p>用户代表企业、机构或其他组织使用本软件时，应确保其具有代表该组织提交数据、授权处理数据和接受本协议的权限。数据原则上仅在实现服务目的所需期限内保存；具体期限可能因本地功能、第三方规则、投诉、安全审计、财务结算或法律要求而不同。</p><p>在不违反法定义务、争议处理和安全留存要求的前提下，用户可以删除本地记录，或通过服务方公布的渠道申请删除由服务方控制的数据。因备份、灾备、缓存、审计或第三方机制无法立即删除的，将在相应期限届满或技术条件允许时处理。卸载软件或清空本地记录不等同于删除已经发送至第三方的数据，用户应按第三方规则另行申请。</p><p>如用户选择境外第三方模型、存储或接口，数据可能被传输至境外。用户应自行确认具有相应授权，并依法完成必要的告知、同意、评估或其他跨境合规程序。</p></section>

        <section><h3>十四、内容审查、风险控制和服务措施</h3><p>为履行法律义务、保护用户及第三方权益、维护系统安全和防止滥用，服务方可能通过自动化工具、人工审核或其他合理方式，对提示词、上传内容、生成内容、账户行为和调用记录进行风险识别。风险识别可能存在误判、漏判或延迟，服务方不保证所有违法、侵权、欺诈、虚假或高风险内容均能被识别和拦截。</p><p>对于涉嫌违法、侵权、欺诈、滥用、绕过安全措施或可能造成现实损害的请求，服务方有权：（1）拒绝生成、编辑、分析、导出或传播；（2）要求补充身份、授权或权利证明；（3）限制账户、设备、接口或相关功能；（4）删除、隔离、屏蔽或限制访问有关内容；（5）保存必要记录和证据；（6）向权利人、平台或有权机关提供必要协助；（7）依法向主管部门报告。</p><p>用户对拒绝、延迟、限制或误判有异议的，应通过服务方公布的渠道提交任务编号、相关内容和权利证明。服务方采取措施不代表对内容作出最终违法、侵权或事实认定，也不替代司法或行政机关的结论。</p></section>

        <section><h3>十五、投诉、侵权通知及申诉</h3><p>权利人认为用户通过本软件提交、生成、发布或传播的内容侵犯其合法权益的，可以向服务方提交投诉。投诉材料原则上应包括：（1）投诉人的身份、联系方式和主体资格证明；（2）权利类型及权利证明；（3）涉嫌侵权内容的位置、截图、任务编号或可识别信息；（4）涉嫌侵权的事实和理由；（5）对投诉真实性、合法性和完整性的声明。</p><p>服务方有权将投诉材料转交相关用户，并要求其在合理期限内说明情况、提交授权证明或采取删除、修改、停止使用等措施。用户可以提交反通知及相关证据。服务方将根据材料完整性、风险程度和适用规则处理，但不承担替代司法机关进行最终权利认定的义务。恶意、虚假或利用投诉机制打击竞争对手的投诉人，应依法承担相应责任。</p></section>

        <section><h3>十六、商业发布及用户的持续责任</h3><p>用户对最终发布、销售、广告、印刷、投放、传播或提供给第三方的内容承担独立责任，不得仅以“AI生成”“AI辅助”“仅供参考”“以实物为准”或类似声明，免除其对商品真实性、广告合规、消费者权益和知识产权的法定义务。</p><p>用户使用生成内容宣传商品时，应确保以下信息具有真实依据：（1）名称、品牌、型号、规格、尺寸和重量；（2）材料、成分、工艺、产地和生产信息；（3）功能、性能、用途、适用人群和限制条件；（4）认证、检测、专利、奖项、销量和排名；（5）价格、折扣、库存、配送、售后和服务承诺；（6）医疗、保健、美容、食品、金融、教育等特殊领域的专业表述。</p><p>用户不得利用生成内容制造不存在的消费者评价、专家推荐、检测结果、使用效果、交易记录、销量数据或媒体报道。如生成内容与真实商品存在差异，用户应在发布前修改、替换或删除，不得以模型、软件、接口或自动生成错误作为向消费者免责的理由。公开发布时，用户还应核对相应平台规则和行业监管要求。</p></section>

        <section><h3>十七、未成年人及特殊人群</h3><p>未满十八周岁的用户应在监护人同意、指导和监督下使用本软件。监护人应对未成年人的使用行为、上传内容、账户安全、消费行为和生成结果履行相应管理责任。</p><p>用户不得利用本软件制作、传播或诱导未成年人参与违法、欺诈、危险、色情、暴力、歧视或其他不适当活动。涉及未成年人肖像、声音、个人信息或其他权益的素材，应取得监护人及其他必要权利人的合法授权。</p></section>

        <section><h3>十八、服务变更、暂停和终止</h3><p>服务方有权根据业务调整、技术升级、法律法规变化、第三方服务变化或安全风险，对软件功能、界面、模型接入、调用限制、存储方式和服务范围进行合理变更。对收费、数据处理或用户权利义务产生重大影响的变更，将通过弹窗、公告或其他显著方式提示，并在依法需要时取得用户重新确认。</p><p>用户违反本协议或法律法规，实施侵权、欺诈、攻击、滥用或其他高风险行为，提供虚假身份或授权，第三方服务无法继续支持，出现安全事件、监管要求、欠费或异常计费风险时，服务方有权暂停或终止全部或部分服务。服务终止后，已经产生的付款、保密、知识产权、数据合规、赔偿和责任限制义务继续有效。</p></section>

        <section><h3>十九、用户赔偿责任</h3><p>如因用户上传、输入、生成、发布或传播的内容侵犯第三方权利，用户违反本协议、第三方规则或法律法规，实施虚假宣传、欺诈销售、不正当竞争，泄露凭证、未经授权调用接口，未履行授权、告知、同意、备案、标识或审核义务，或者未经人工审核直接使用生成内容，导致服务方、关联方、员工、代理人、技术服务商或合作方遭受索赔、处罚、损失、费用或支出，用户应在法律允许范围内承担赔偿责任。</p><p>赔偿范围可以包括合理的律师费、诉讼费、仲裁费、公证费、调查费、技术鉴定费、和解金、依法可以转由用户承担的行政罚款，以及为防止损失扩大支出的合理费用；法律明确禁止转嫁的责任除外。</p></section>

        <section className="disclaimer-important"><h3>二十、责任限制</h3><p>在法律允许的最大范围内，服务方不保证：（1）生成内容真实、准确、完整、合法、唯一或适销；（2）生成内容不含错误、偏见、幻觉、侵权风险或不适当内容；（3）软件、模型或第三方接口持续可用、无中断、无延迟或无故障；（4）结果满足用户商业目的、平台审核或特定行业要求；（5）生成内容能够取得知识产权保护；（6）软件能够发现并消除全部安全、违法和侵权风险。</p><p>对于因用户提交错误、虚假、不完整或无权使用的素材，未经审核直接使用生成内容，违反第三方或平台规则，第三方接口、网络、云服务或设备故障，不可抗力、攻击、恶意程序、监管措施，自行修改或再次生成内容，以及未及时采取账户、数据或凭证安全措施造成的损失，服务方在法律允许范围内不承担责任。</p><p>在法律允许范围内，服务方不对间接损失、预期利润损失、商誉损失、数据丢失、业务中断或机会损失承担责任。如服务方依法应承担赔偿责任，除法律另有强制性规定，或服务方存在故意、重大过失、造成人身损害等情形外，赔偿责任原则上不超过用户在责任事由发生前十二个月内实际支付的相关服务费用；对于免费服务，责任上限原则上为人民币一千元或法律允许的其他合理金额。</p><p><b>本条不免除或限制依法不得免除或限制的责任，也不排除用户依法享有的消费者权利、投诉权、诉讼权和其他救济权利。</b></p></section>

        <section><h3>二十一、保密义务</h3><p>一方因使用本软件而知悉另一方未公开的技术、商业、财务、客户、产品、运营或其他保密信息的，应采取合理措施保密，未经信息提供方书面同意，不得向无关第三方披露或用于履行本协议以外的目的。</p><p>已经公开、非因接收方原因公开、接收方能够证明事先合法持有、从有权披露的第三方合法取得，或依法必须披露的信息不属于保密信息。依法必须披露时，接收方应在法律允许范围内提前通知对方并仅披露必要范围。本条在协议终止后三年内继续有效；涉及商业秘密的信息，在其依法构成商业秘密期间持续有效。</p></section>

        <section><h3>二十二、电子通知及协议更新</h3><p>服务方可以通过软件弹窗、站内信、公告、电子邮件、短信或其他合理方式发送通知。在法律允许范围内，通知发送至用户登记或实际使用的联系方式后视为发出；用户应及时维护联系方式和设备状态。</p><p>非实质性调整可以通过更新页面、公告或软件提示公布。对收费、数据处理、责任承担、服务范围或用户主要权利义务产生重大影响的修改，服务方应以显著方式提示，并在法律要求时取得用户重新确认。用户不同意修改内容的，应停止使用相关服务；法律规定需要单独同意的，不以继续使用代替同意。</p></section>

        <section><h3>二十三、适用法律及争议解决</h3><p>本协议的订立、效力、解释、履行和争议解决适用中华人民共和国法律；法律法规另有强制性规定的，从其规定。</p><p>因本协议产生或与本协议有关的争议，双方应先友好协商解决；协商不成的，任一方可以向依法有管辖权的人民法院提起诉讼。任何条款被认定无效、违法或不可执行的，不影响其他条款效力，双方应以最接近原条款目的且合法有效的条款替代。</p></section>

        <section><h3>二十四、协议完整性</h3><p>本协议、隐私政策、第三方服务规则、收费规则、产品说明、功能页面和服务方发布的其他专项规则，共同构成用户与服务方之间的完整约定。</p><p>不同文件存在冲突时，除页面另有明确说明外，适用顺序为：（1）法律法规及监管要求；（2）针对特定功能单独展示并由用户确认的专项规则；（3）隐私政策；（4）本协议；（5）其他产品说明或操作提示。</p></section>

        <section className="disclaimer-important"><h3>二十五、协议解释权</h3><p>在法律允许的范围内，本协议及软件相关功能、页面规则和使用说明的最终解释与说明由软件作者负责。该解释不得违反法律法规的强制性规定，不得不合理免除或减轻服务方责任、加重用户责任或排除用户依法享有的主要权利。</p><p>用户对相关解释有异议的，可以依法提出投诉、协商或寻求司法、仲裁及其他救济；服务方的解释与有权机关的生效认定不一致时，以有权机关的认定为准。</p></section>
        </div>
      </div>}

      {required
        ? <div className="disclaimer-actions"><small>点击“同意并继续”，即表示你已阅读、理解并同意受上述协议约束。</small><button type="button" className="save" onClick={onAccept}>同意并继续</button></div>
        : <div className="disclaimer-actions is-view"><button type="button" className="save" onClick={onClose}>关闭</button></div>}
    </div>
  </div>
}

function getImage(item) {
  if (item?.url) return item.url
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`
  return ''
}

function readSourceDimensions(item) {
  if (item?.width && item?.height) return Promise.resolve({ width: item.width, height: item.height })
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('无法读取上传主图的宽高'))
    img.src = item?.url || ''
  })
}

function sizeRatio(width, height) {
  let x = Math.max(1, Math.round(Number(width) || 1))
  let y = Math.max(1, Math.round(Number(height) || 1))
  const originalX = x
  const originalY = y
  while (y) [x, y] = [y, x % y]
  return `${Math.round(originalX / x)}:${Math.round(originalY / x)}`
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) {
    throw new Error(`本地服务没有返回内容（HTTP ${response.status}）`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`本地服务返回了无法识别的内容（HTTP ${response.status}）`)
  }
}

function friendlyError(message) {
  if (isRetryableTimeout(message)) return '接口服务器响应超时，系统已自动重试；请稍后再次尝试失败的图片。'
  if (/<\/?(?:html|head|body|title|center|h1|hr)\b|nginx/i.test(message)) return '图片生成服务暂时繁忙，请稍后再试。'
  if (/No available channel for model/i.test(message)) {
    const group = message.match(/under group\s+([^\s(]+)/i)?.[1]
    return `NewAPI 已连接，但${group ? `令牌分组“${group}”` : '当前令牌分组'}没有该模型的可用渠道。请点击“测试接口”选择可用图片模型，或在 NewAPI 后台为该分组启用对应渠道。`
  }
  if (/401|unauthorized|invalid.*key/i.test(message)) return 'API Key 无效或没有访问权限，请检查接口设置。'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) return '无法连接 NewAPI，请检查 Base URL、端口以及 NewAPI 服务是否已启动。'
  return message.length > 300 ? '图片生成请求失败，请检查接口设置或稍后再试。' : message
}

const browserLocalDirectoryPrefix = 'browser-local:'

function isBrowserLocalDirectory(value) {
  return (value || '').toString().startsWith(browserLocalDirectoryPrefix)
}

function browserLocalDirectoryLabel(handle) {
  return `${browserLocalDirectoryPrefix}${handle.name || '已授权文件夹'}`
}

function isLocalWebHost() {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
}

function canUseBrowserDirectoryPicker() {
  return typeof window !== 'undefined' && Boolean(window.showDirectoryPicker) && (window.isSecureContext || isLocalWebHost())
}

function directoryPickerUnavailableMessage() {
  if (!window.isSecureContext && !isLocalWebHost()) {
    return '当前页面不是 HTTPS，浏览器禁止网页选择本机文件夹。请改用 HTTPS 域名访问，或使用桌面版。'
  }
  return '当前浏览器不支持网页选择本机文件夹。请使用最新版 Chrome 或 Edge，或使用桌面版。'
}

function safeLocalFilename(value) {
  return (value || 'image').toString().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').slice(0, 100) || 'image'
}

function extensionFromBlob(blob) {
  const type = (blob?.type || '').match(/^image\/([^;]+)/i)?.[1]
  return safeLocalFilename((type || 'png').replace('jpeg', 'jpg'))
}

async function ensureDirectoryWritePermission(handle) {
  if (!handle?.queryPermission || !handle?.requestPermission) return
  const options = { mode: 'readwrite' }
  if (await handle.queryPermission(options) === 'granted') return
  if (await handle.requestPermission(options) !== 'granted') throw new Error('没有获得写入所选文件夹的权限')
}

async function imageSourceToBlob(src) {
  let response
  try {
    response = await fetch(src)
    if (!response.ok) throw new Error(`下载图片失败（${response.status}）`)
  } catch {
    response = await fetch('/api/image-blob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: src }),
    })
  }
  if (!response.ok) throw new Error(`下载图片失败（${response.status}）`)
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('下载内容不是图片')
  return blob
}

function App({ currentUser, onLogout }) {
  const isAdmin = currentUser.role === 'admin'
  const [settings, setSettings] = useState(defaults)
  const [settingsConfigured, setSettingsConfigured] = useState(false)
  const [mode, setMode] = useState('generate')
  const [prompts, setPrompts] = useState({ generate: '', edit: '' })
  const [toolOptions, setToolOptions] = useState(() => {
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem('image-studio-tool-options') || '{}') }
    catch {}
    const initial = { size: normalizeStandardSize(settings.size), quality: settings.quality, count: 1 }
    const generate = { ...initial, ...saved.generate, count: normalizeToolGenerationCount(saved.generate?.count) }
    const edit = { ...initial, customWidth: 1024, customHeight: 1024, ...saved.edit, count: normalizeToolGenerationCount(saved.edit?.count) }
    const editSize = saved.edit?.sizeModeVersion === 1 ? normalizeEditSize(edit.size) : 'source'
    return {
      generate: { ...generate, size: normalizeStandardSize(generate.size), quality: normalizeGenerationQuality(generate.quality) },
      edit: { ...edit, size: editSize, quality: normalizeGenerationQuality(edit.quality), sizeModeVersion: 1 },
    }
  })
  const [sources, setSources] = useState([])
  const [activeSource, setActiveSource] = useState(0)
  const [resultsByMode, setResultsByMode] = useState({ generate: [], edit: [], commerce: [] })
  const [toolRuns, setToolRuns] = useState({
    generate: { running: false, paused: false, progress: { done: 0, total: 0 }, error: '' },
    edit: { running: false, paused: false, progress: { done: 0, total: 0 }, error: '' },
  })
  const [commerceRun, setCommerceRun] = useState({ running: false, progress: { done: 0, total: 0 }, error: '' })
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [adminCenterOpen, setAdminCenterOpen] = useState(false)
  const [adminChildOpen, setAdminChildOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingSaving, setBillingSaving] = useState(false)
  const [billingMessage, setBillingMessage] = useState(null)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentMessage, setPaymentMessage] = useState(null)
  const [pointBalance, setPointBalance] = useState(Number(currentUser.pointsBalance) || 0)
  const [checkIn, setCheckIn] = useState(currentUser.checkIn || null)
  const [checkInSaving, setCheckInSaving] = useState(false)
  const [rechargeAmount, setRechargeAmount] = useState('')
  const [rechargeOrders, setRechargeOrders] = useState([])
  const [rechargeOrdersExpanded, setRechargeOrdersExpanded] = useState(false)
  const [rechargeSaving, setRechargeSaving] = useState(false)
  const [membershipSaving, setMembershipSaving] = useState('')
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(hasAcceptedDisclaimer)
  const [disclaimerOpen, setDisclaimerOpen] = useState(() => !hasAcceptedDisclaimer())
  const [billing, setBilling] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('image-studio-billing') || '{}')
      return { ...defaultBilling, imageCount: Number(saved.imageCount) || 0, copyCount: Number(saved.copyCount) || 0 }
    }
    catch { return defaultBilling }
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateRunning, setUpdateRunning] = useState(false)
  const [updateResult, setUpdateResult] = useState(null)
  const [modelCatalog, setModelCatalog] = useState({ image: [], text: [] })
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const [browserSaveDirectory, setBrowserSaveDirectory] = useState(null)
  const [sourceDragActive, setSourceDragActive] = useState(false)
  const [sourcePreparation, setSourcePreparation] = useState({ running: false, done: 0, total: 0, message: '' })
  const maskEditorRef = useRef(null)
  const toolAbortRefs = useRef({ generate: null, edit: null })
  const toolPauseRefs = useRef({ generate: false, edit: false })
  const commerceAbortRef = useRef(new Set())
  const commercePauseRef = useRef(false)
  const directoryAbortRef = useRef(null)
  const browserSaveDirectoryRef = useRef(null)
  const sourceDragDepthRef = useRef(0)

  function mergeSettingsWithBrowserDirectory(current, next) {
    if (!browserSaveDirectoryRef.current) return { ...current, ...next }
    return { ...current, ...next, saveDirectory: current.saveDirectory || browserLocalDirectoryLabel(browserSaveDirectoryRef.current) }
  }

  useEffect(() => {
    let active = true
    fetch('/api/app-config')
      .then(readJsonResponse)
      .then(data => {
        if (!active) return
        setSettings(current => mergeSettingsWithBrowserDirectory(current, data))
        setBillingMessage(null)
        setSettingsConfigured(Boolean(data.configured))
      })
      .catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [])

  useEffect(() => localStorage.setItem('image-studio-billing', JSON.stringify(billing)), [billing])
  useEffect(() => localStorage.setItem('image-studio-tool-options', JSON.stringify(toolOptions)), [toolOptions])
  useEffect(() => () => {
    Object.values(toolAbortRefs.current).forEach(controller => controller?.abort())
  }, [])

  const headers = useMemo(() => ({}), [])

  function updateToolOptions(tool, patch) {
    const safePatch = Object.hasOwn(patch, 'count')
      ? { ...patch, count: normalizeToolGenerationCount(patch.count) }
      : patch
    setToolOptions(old => ({ ...old, [tool]: { ...old[tool], ...safePatch } }))
  }

  function updateToolRun(tool, patch) {
    setToolRuns(old => {
      const current = old[tool]
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
      return { ...old, [tool]: next }
    })
  }

  function setToolError(tool, message) {
    updateToolRun(tool, { error: message })
  }

  function updateCommerceRun(patch) {
    setCommerceRun(current => typeof patch === 'function' ? patch(current) : { ...current, ...patch })
  }

  async function openSettings() {
    if (!isAdmin) return
    setSettingsOpen(true)
    setTestResult(null)
    try {
      const response = await fetch('/api/admin/settings')
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '无法读取接口设置')
      setSettings(current => ({ ...current, ...data.settings }))
    } catch (requestError) {
      setTestResult({ ok: false, message: requestError.message })
    }
  }

  function closeSettings() {
    setSettingsOpen(false)
    if (adminChildOpen) {
      setAdminChildOpen(false)
      setAdminCenterOpen(true)
    }
  }

  function openStorageSettings() {
    setSettingsOpen(true)
    setTestResult(null)
  }

  async function saveSettings() {
    setSettingsSaving(true)
    setTestResult(null)
    const keepBrowserDirectory = isBrowserLocalDirectory(settings.saveDirectory)
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, saveDirectory: keepBrowserDirectory ? '' : settings.saveDirectory }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '保存接口设置失败')
      setSettingsConfigured(Boolean(data.configured))
      setSettings(current => ({ ...current, ...(data.settings || {}), ...(keepBrowserDirectory ? { saveDirectory: current.saveDirectory } : {}), apiKey: '', hasApiKey: data.configured }))
      setSettingsOpen(false)
      if (adminChildOpen) {
        setAdminChildOpen(false)
        setAdminCenterOpen(true)
      }
      setError('')
    } catch (requestError) {
      setTestResult({ ok: false, title: '保存失败', message: requestError.message })
    } finally {
      setSettingsSaving(false)
    }
  }

  async function saveStorageSettings() {
    setSettingsSaving(true)
    setTestResult(null)
    const keepBrowserDirectory = isBrowserLocalDirectory(settings.saveDirectory)
    try {
      const response = await fetch('/api/storage-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSave: Boolean(settings.autoSave), saveDirectory: keepBrowserDirectory ? '' : settings.saveDirectory || '' }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '保存本地保存设置失败')
      setSettings(current => ({ ...current, ...data.settings, ...(keepBrowserDirectory ? { saveDirectory: current.saveDirectory } : {}) }))
      setSettingsOpen(false)
      setError('')
    } catch (requestError) {
      setTestResult({ ok: false, message: requestError.message })
    } finally {
      setSettingsSaving(false)
    }
  }

  function acceptDisclaimer() {
    localStorage.setItem(disclaimerStorageKey, JSON.stringify({
      accepted: true,
      version: disclaimerVersion,
      acceptedAt: new Date().toISOString(),
    }))
    setDisclaimerAccepted(true)
    setDisclaimerOpen(false)
  }

  function addImageCharge(quantity) {
    if (quantity) setBilling(old => ({ ...old, imageCount: old.imageCount + quantity }))
  }

  function addCopyCharge() {
    setBilling(old => ({ ...old, copyCount: old.copyCount + 1 }))
  }

  function updateCurrentUser(user) {
    if (user && Object.hasOwn(user, 'pointsBalance')) setPointBalance(Number(user.pointsBalance) || 0)
    if (user && Object.hasOwn(user, 'checkIn')) setCheckIn(user.checkIn || null)
    if (user && Object.hasOwn(user, 'membershipLevel')) {
      const label = user.membershipLevel === 'svip' ? 'SVIP' : user.membershipLevel === 'vip' ? 'VIP' : '普通用户'
      setSettings(current => ({ ...current, membershipLevel: user.membershipLevel || 'normal', membershipLabel: label }))
    }
  }

  function formatPoints(value) {
    const points = Number(value) || 0
    return Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/\.?0+$/, '')
  }

  async function refreshWallet() {
    const response = await fetch('/api/wallet')
    const data = await readJsonResponse(response)
    if (!response.ok) throw new Error(data?.error?.message || '读取钱包信息失败')
    if (data.user) updateCurrentUser(data.user)
    if (data.settings) setSettings(current => ({ ...current, ...data.settings }))
    setRechargeOrders(Array.isArray(data.rechargeOrders) ? data.rechargeOrders : [])
    return data
  }

  async function refreshCheckIn() {
    const response = await fetch('/api/check-in')
    const data = await readJsonResponse(response)
    if (!response.ok) throw new Error(data?.error?.message || '读取签到状态失败')
    if (data.user) updateCurrentUser(data.user)
    return data.checkIn || null
  }

  async function openBillingPanel() {
    setBillingMessage(null)
    setRechargeOrdersExpanded(false)
    setBillingOpen(true)
    try {
      await refreshWallet()
      if (!isAdmin) await refreshCheckIn()
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
    }
  }

  function closeBillingPanel() {
    setBillingOpen(false)
    if (adminChildOpen) {
      setAdminChildOpen(false)
      setAdminCenterOpen(true)
    }
  }

  function closePaymentPanel() {
    setPaymentOpen(false)
    if (adminChildOpen) {
      setAdminChildOpen(false)
      setAdminCenterOpen(true)
    }
  }

  function closeUsersPanel() {
    setUsersOpen(false)
    if (adminChildOpen) {
      setAdminChildOpen(false)
      setAdminCenterOpen(true)
    }
  }

  function closeOrdersPanel() {
    setOrdersOpen(false)
    if (adminChildOpen) {
      setAdminChildOpen(false)
      setAdminCenterOpen(true)
    }
  }

  function openAdminCenterSection(section) {
    setAdminCenterOpen(false)
    setAdminChildOpen(true)
    if (section === 'billing') return openBillingPanel()
    if (section === 'users') return setUsersOpen(true)
    if (section === 'orders') return setOrdersOpen(true)
    if (section === 'payment') {
      setPaymentMessage(null)
      return setPaymentOpen(true)
    }
    if (section === 'settings') return openSettings()
  }

  async function savePointSettings() {
    if (!isAdmin) return
    setBillingSaving(true)
    setBillingMessage(null)
    try {
      const response = await fetch('/api/admin/point-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imagePointCost: settings.imagePointCost,
          copyPointCost: settings.copyPointCost,
          rechargeRate: settings.rechargeRate,
          normalImagePrice: settings.normalImagePrice,
          normalCopyPrice: settings.normalCopyPrice,
          vipImagePrice: settings.vipImagePrice,
          vipCopyPrice: settings.vipCopyPrice,
          vipDescription: settings.vipDescription,
          svipImagePrice: settings.svipImagePrice,
          svipCopyPrice: settings.svipCopyPrice,
          svipDescription: settings.svipDescription,
          vipOpenPrice: settings.vipOpenPrice,
          svipOpenPrice: settings.svipOpenPrice,
          checkInRewardPoints: settings.checkInRewardPoints,
          checkInWindowDays: settings.checkInWindowDays,
        }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '保存积分规则失败')
      setSettings(current => ({ ...current, ...data.settings }))
      setBillingMessage({ ok: true, text: '积分和签到规则已保存' })
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
    } finally {
      setBillingSaving(false)
    }
  }

  async function savePaymentSettings() {
    if (!isAdmin) return
    setPaymentSaving(true)
    setPaymentMessage(null)
    try {
      const response = await fetch('/api/admin/payment-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentEnabled: settings.paymentEnabled,
          paymentGatewayUrl: settings.paymentGatewayUrl,
          paymentCallbackBaseUrl: settings.paymentCallbackBaseUrl,
          paymentReturnUrl: settings.paymentReturnUrl,
          paymentMerchantId: settings.paymentMerchantId,
          paymentMerchantKey: settings.paymentMerchantKey,
          paymentMinAmount: settings.paymentMinAmount,
        }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '保存支付配置失败')
      setSettings(current => ({ ...current, ...data.settings }))
      setPaymentMessage({ ok: true, text: '支付配置已保存' })
    } catch (error) {
      setPaymentMessage({ ok: false, text: error.message })
    } finally {
      setPaymentSaving(false)
    }
  }

  async function checkInToday() {
    setCheckInSaving(true)
    setBillingMessage(null)
    try {
      const response = await fetch('/api/check-in', { method: 'POST' })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '签到失败')
      if (data.user) updateCurrentUser(data.user)
      if (data.checkIn) setCheckIn(data.checkIn)
      setBillingMessage({ ok: true, text: `签到成功，获得 ${formatPoints(data.rewardPoints ?? checkInInfo?.rewardPoints ?? defaults.checkInRewardPoints)} 积分` })
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
      try { await refreshCheckIn() } catch {}
    } finally {
      setCheckInSaving(false)
    }
  }

  async function rechargePoints(event) {
    event.preventDefault()
    setRechargeSaving(true)
    setBillingMessage(null)
    try {
      const response = await fetch('/api/recharge-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: rechargeAmount, method: 'alipay' }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '充值失败')
      setRechargeAmount('')
      if (data.order) setRechargeOrders(old => [data.order, ...old].slice(0, 20))
      if (data.gatewayUrl && data.form) {
        submitPaymentForm(data.gatewayUrl, data.form)
        setBillingMessage({ ok: true, text: `充值订单已创建，待支付成功后到账 ${formatPoints(data.order?.points)} 积分` })
      } else {
        updateCurrentUser(data.user)
        setBillingMessage({ ok: true, text: `充值成功，获得 ${formatPoints(data.points)} 积分` })
      }
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
    } finally {
      setRechargeSaving(false)
    }
  }

  async function buyMembership(level) {
    setMembershipSaving(level)
    setBillingMessage(null)
    try {
      const response = await fetch('/api/membership-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '创建会员订单失败')
      if (data.order) setRechargeOrders(old => [data.order, ...old].slice(0, 20))
      if (data.gatewayUrl && data.form) {
        submitPaymentForm(data.gatewayUrl, data.form)
        setBillingMessage({ ok: true, text: `${level === 'svip' ? 'SVIP' : 'VIP'} 会员订单已创建，支付成功后会自动升级` })
      }
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
    } finally {
      setMembershipSaving('')
    }
  }

  async function cancelOrder(order) {
    if (!window.confirm('确定取消这个待支付订单吗？取消后需要重新创建订单才能支付。')) return
    setBillingMessage(null)
    try {
      const response = await fetch(`/api/orders/${order.id}/cancel`, { method: 'POST' })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '取消订单失败')
      setRechargeOrders(old => old.map(item => item.id === order.id ? data.order : item))
      setBillingMessage({ ok: true, text: '订单已取消' })
    } catch (error) {
      setBillingMessage({ ok: false, text: error.message })
    }
  }

  async function chooseSaveDirectory() {
    if (selectingDirectory) {
      directoryAbortRef.current?.abort()
      return
    }
    setSelectingDirectory(true)
    let controller = null
    try {
      let directory = ''
      if (window.desktopStorage?.selectDirectory) {
        directory = await window.desktopStorage.selectDirectory()
        setBrowserSaveDirectory(null)
        browserSaveDirectoryRef.current = null
      } else if (canUseBrowserDirectoryPicker()) {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
        await ensureDirectoryWritePermission(handle)
        setBrowserSaveDirectory(handle)
        browserSaveDirectoryRef.current = handle
        directory = browserLocalDirectoryLabel(handle)
      } else if (isLocalWebHost()) {
        controller = new AbortController()
        directoryAbortRef.current = controller
        const response = await fetch('/api/select-directory', { method: 'POST', signal: controller.signal })
        const data = await readJsonResponse(response)
        if (!response.ok) throw new Error(data?.error?.message || '无法打开文件夹选择器')
        directory = data.directory
        setBrowserSaveDirectory(null)
        browserSaveDirectoryRef.current = null
      } else {
        throw new Error(directoryPickerUnavailableMessage())
      }
      if (directory) setSettings(old => ({ ...old, saveDirectory: directory }))
    } catch (e) {
      if (e.name === 'AbortError' || e.name === 'NotAllowedError') return
      setError(`选择保存文件夹失败：${e.message}`)
    } finally {
      if (!controller || directoryAbortRef.current === controller) {
        directoryAbortRef.current = null
        setSelectingDirectory(false)
      }
    }
  }

  async function autoSaveBrowserLocalItem(item, category, label) {
    const root = browserSaveDirectoryRef.current
    if (!root) throw new Error('浏览器本地保存权限已失效，请重新选择文件夹')
    await ensureDirectoryWritePermission(root)
    const categoryDirectory = await root.getDirectoryHandle(safeLocalFilename(category), { create: true })
    const blob = await imageSourceToBlob(item.src)
    const fileHandle = await categoryDirectory.getFileHandle(`${safeLocalFilename(`${label}-${Date.now()}`)}.${extensionFromBlob(blob)}`, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }
    return { ...item, savedPath: `${root.name || '已授权文件夹'}\\${category}\\${fileHandle.name}` }
  }

  async function autoSaveItem(item) {
    if (!settings.autoSave || !settings.saveDirectory || !item.src) return item
    const categoryNames = { main: '商品主图', sku: 'SKU图', detail: '商品详情图' }
    const category = categoryNames[item.commerceCategory] || (item.mode === 'edit' ? '图片编辑' : '文字生图')
    const label = item.commerceLabel || (item.mode === 'edit' ? '图片编辑' : '文字生图')
    try {
      if (isBrowserLocalDirectory(settings.saveDirectory)) {
        return await autoSaveBrowserLocalItem(item, category, label)
      }
      const response = await fetch('/api/save-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: settings.saveDirectory, image: item.src, category, filename: `${label}-${Date.now()}` }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '自动保存失败')
      return { ...item, savedPath: data.path }
    } catch (e) {
      return { ...item, saveError: e.message }
    }
  }

  async function testConnection() {
    if (!settings.baseUrl || (!settings.apiKey && !settings.hasApiKey)) {
      setTestResult({ ok: false, message: '请先填写 Base URL 和 API Key' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, copyModel: settings.copyModel, chatModel: settings.chatModel }),
      })
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '接口测试失败')
      setModelCatalog({ image: data.imageModels || [], text: data.textModels || [] })
      setTestResult({
        ...data,
        message: data.modelAvailable === false
          ? `接口可连接，但当前令牌看不到图片模型“${settings.model}”。`
          : data.copyModelAvailable === false
            ? `图片模型可用，但当前令牌看不到文案分析模型“${settings.copyModel}”。请从下方文本模型中选择。`
            : data.chatModelAvailable === false
              ? `图片和文案模型可用，但当前令牌看不到 AI 对话模型“${settings.chatModel}”。请从文本模型下拉框中选择。`
            : data.message,
      })
    } catch (e) {
      setTestResult({ ok: false, message: friendlyError(e.message) })
    } finally {
      setTesting(false)
    }
  }

  async function checkSystemUpdate() {
    if (!isAdmin) return
    setUpdateChecking(true)
    setUpdateResult(null)
    try {
      const response = await fetch('/api/admin/update/status')
      const data = await readJsonResponse(response)
      if (!response.ok) throw new Error(data?.error?.message || '检查更新失败')
      setUpdateResult(data)
    } catch (error) {
      setUpdateResult({ ok: false, message: error.message, steps: [] })
    } finally {
      setUpdateChecking(false)
    }
  }

  async function runSystemUpdate() {
    if (!isAdmin) return
    if (!window.confirm('确定要从 GitHub 拉取最新代码、重新安装依赖、构建项目并重启本站服务吗？更新期间请不要重复点击。')) return
    setUpdateRunning(true)
    setUpdateResult({ ok: true, message: '正在执行更新，请稍候…', steps: [] })
    try {
      const response = await fetch('/api/admin/update/run', { method: 'POST' })
      const data = await readJsonResponse(response)
      if (!response.ok) {
        setUpdateResult({ ...data, ok: false, message: data?.error?.message || data?.message || '自动更新失败' })
        return
      }
      setUpdateResult(data)
    } catch (error) {
      setUpdateResult(current => ({ ...(current || {}), ok: false, message: error.message, steps: current?.steps || [] }))
    } finally {
      setUpdateRunning(false)
    }
  }

  async function selectFiles(fileList, { replace = false } = {}) {
    if (sourcePreparation.running) return setToolError('edit', '图片正在自动优化，请稍候')
    const files = Array.from(fileList || []).filter(file => file?.type?.startsWith('image/') || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file?.name || ''))
    if (!files.length) return setToolError('edit', '请选择图片文件')
    const additions = files.slice(0, Math.max(0, 10 - (replace ? 0 : sources.length)))
    if (!additions.length) return setToolError('edit', '主图和参考图最多共 10 张')
    setSourcePreparation({ running: true, done: 0, total: additions.length, message: '' })
    setToolError('edit', '')
    const sourceItems = []
    const failures = []
    try {
      for (let index = 0; index < additions.length; index++) {
        const originalFile = additions[index]
        try {
          const optimized = await optimizeImageForGpt(originalFile)
          sourceItems.push({
            ...optimized,
            url: URL.createObjectURL(optimized.file),
            id: crypto.randomUUID(),
            originalName: originalFile.name,
          })
        } catch (error) {
          failures.push(`${originalFile.name}：${error.message}`)
        }
        setSourcePreparation(current => ({ ...current, done: index + 1 }))
      }

      if (sourceItems.length) {
        if (replace) {
          sources.forEach(item => URL.revokeObjectURL(item.url))
          setSources(sourceItems)
          setActiveSource(0)
        } else {
          setSources(old => [...old, ...sourceItems])
        }
      }

      const optimizedCount = sourceItems.filter(item => item.optimized).length
      const originalBytes = sourceItems.reduce((sum, item) => sum + item.originalBytes, 0)
      const processedBytes = sourceItems.reduce((sum, item) => sum + item.processedBytes, 0)
      const limitMessage = files.length > additions.length ? `；主图和参考图最多共 10 张，本次添加 ${additions.length} 张` : ''
      const failureMessage = failures.length ? `；${failures.length} 张处理失败：${failures.join('；')}` : ''
      const message = sourceItems.length
        ? `已准备 ${sourceItems.length} 张图片，其中 ${optimizedCount} 张自动降采样；${formatImageBytes(originalBytes)} → ${formatImageBytes(processedBytes)}${limitMessage}${failureMessage}`
        : failureMessage.replace(/^；/, '')
      setSourcePreparation({ running: false, done: additions.length, total: additions.length, message })
      if (!sourceItems.length || failures.length) setToolError('edit', message || '图片优化失败')
    } catch (error) {
      sourceItems.forEach(item => URL.revokeObjectURL(item.url))
      setSourcePreparation({ running: false, done: 0, total: additions.length, message: '' })
      setToolError('edit', `图片优化失败：${error.message}`)
    }
  }

  function sourceDragEnter(event) {
    event.preventDefault()
    event.stopPropagation()
    sourceDragDepthRef.current += 1
    setSourceDragActive(true)
  }

  function sourceDragOver(event) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  function sourceDragLeave(event) {
    event.preventDefault()
    event.stopPropagation()
    sourceDragDepthRef.current = Math.max(0, sourceDragDepthRef.current - 1)
    if (sourceDragDepthRef.current === 0) setSourceDragActive(false)
  }

  function dropSourceFiles(event) {
    event.preventDefault()
    event.stopPropagation()
    sourceDragDepthRef.current = 0
    setSourceDragActive(false)
    const itemFiles = Array.from(event.dataTransfer?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean)
    selectFiles(itemFiles.length ? itemFiles : event.dataTransfer?.files)
  }

  function openCommercePrompt(files, value) {
    setPrompts(old => ({ ...old, edit: value }))
    setMode('edit')
    selectFiles(files, { replace: true })
    window.scrollTo({ top: 260, behavior: 'smooth' })
  }

  async function generateCommerceSet(files, jobs) {
    if (!settingsConfigured) {
      if (isAdmin) openSettings()
      return updateCommerceRun({ error: isAdmin ? '请先完成接口设置' : '管理员尚未完成接口设置，请联系管理员' })
    }
    if (!files.length || !jobs.length) return
    const pendingJobs = jobs.filter(job => !resultsByMode.commerce.some(item => item.commerceCategory === job.category && item.commerceLabel === job.label))
    if (!pendingJobs.length) return updateCommerceRun({ error: '这套电商图片已经全部生成完成' })
    commercePauseRef.current = false
    updateCommerceRun({ running: true, error: '', progress: { done: jobs.length - pendingJobs.length, total: jobs.length } })
    commerceAbortRef.current.clear()
    let nextRequestAt = 0
    let requestGate = Promise.resolve()
    const finalFailures = []

    const wait = delay => new Promise(resolve => window.setTimeout(resolve, delay))
    const waitForRequestSlot = () => {
      const slot = requestGate.then(async () => {
        const remaining = nextRequestAt - Date.now()
        if (remaining > 0) await wait(remaining)
        nextRequestAt = Date.now() + commerceRequestSpacing
      })
      requestGate = slot.catch(() => {})
      return slot
    }

    async function generateCommerceJob(entry) {
      if (commercePauseRef.current) return { success: false, paused: true }
      const { job, index } = entry
      let controller
      try {
        await waitForRequestSlot()
        if (commercePauseRef.current) return { success: false, paused: true }
        controller = new AbortController()
        commerceAbortRef.current.add(controller)
        const jobSize = job.size || (job.category === 'detail' ? '1024x1536' : '1024x1024')
        const jobQuality = ['auto', 'low', 'medium', 'high'].includes(job.quality) ? job.quality : 'auto'
        const [jobWidth, jobHeight] = jobSize.split('x').map(Number)
        const ratioDescription = jobWidth === jobHeight ? '1:1 正方形' : jobWidth > jobHeight ? '横版' : '竖版'
        const categoryRules = job.category === 'detail'
          ? `\n\n【详情图强制质量规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。生成一张完成度高的电商详情页，不是草稿或占位模板。所有核心商品、文字和版式内容必须放在安全区域内，不能超出画布或被裁切。画面必须具有明确的视觉焦点、真实场景或有效细节证据。禁止空白占位框、无意义横线、指示线、线框图、网页 UI、按钮、表格外壳和未完成模板。采用成熟商业设计：统一色调、清晰网格、足够留白但不能大面积空洞、图片与文字比例协调。图片内只呈现 1 个醒目主标题和 2–4 条简短说明，所有可见文字必须使用 ${job.language || 'zh-CN'} 对应的目标语言，文字清晰、无乱码、层级明确，禁止混入其他语言；不要堆砌长段落。${job.includeProduct === false ? '这是一张关联元素详情图：画面中严禁出现商品本体或相似替代商品，应使用相关生活场景、环境、人物动作、材质氛围或搭配元素完成叙事。' : '这是一张展示商品的详情图：商品必须完整可辨认；如果使用局部特写，画面中必须同时保留完整商品作为参照。'} 优先使用多场景叙事、完整视觉证据和前后连续的详情页版式。`
          : job.category === 'sku'
            ? `\n\n【SKU 图强制规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。只生成纯商品摄影图，完整展示商品。禁止出现任何文字、字母、数字、参数、标签、价格、边框、按钮、色块说明、占位线、拼贴模板或网页界面。背景干净统一，商品边缘清晰，比例准确，商品完整位于安全区域内且不能被裁切。整套 SKU 图必须保持相同画布尺寸、商品缩放比例、留白范围和视觉重心。`
            : `\n\n【主图强制质量规范】画布必须严格为 ${jobWidth}×${jobHeight} 像素、${ratioDescription}比例，禁止输出其他宽高比。商品必须完整、清晰并保持参考图一致，所有商品和文字必须位于安全区域内，不能超出画布或被裁切。构图成熟、商业摄影质感强，避免无意义空白、模板线框和商品变形。整套主图必须保持相同画布尺寸、主体缩放范围和视觉重心。`
        const finalPrompt = job.prompt + categoryRules
        let response
        if (job.category === 'detail' && job.includeProduct === false) {
          response = await fetch('/api/generate', {
            method: 'POST', signal: controller.signal,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.model, prompt: finalPrompt, n: 1, size: jobSize, quality: jobQuality, response_format: settings.format }),
          })
        } else {
          const form = new FormData()
          files.forEach(file => form.append('image', file))
          form.append('model', settings.model)
          form.append('prompt', finalPrompt)
          form.append('n', '1')
          form.append('size', jobSize)
          form.append('quality', jobQuality)
          form.append('response_format', settings.format)
          response = await fetch('/api/edit', { method: 'POST', headers, body: form, signal: controller.signal })
        }
        const data = await readJsonResponse(response)
        if (!response.ok) throw new Error(data?.error?.message || '电商图片生成失败')
        updateCurrentUser(data.user)
        const additions = (data.data || []).map((item, n) => ({
          id: `commerce-${Date.now()}-${index}-${n}`,
          src: getImage(item), prompt: job.prompt, mode: 'commerce', commerceCategory: job.category,
          commerceLabel: job.label, commerceSize: jobSize, createdAt: new Date(),
        })).filter(item => item.src)
        if (!additions.length) throw new Error('接口没有返回可识别的图片数据')
        const savedAdditions = await Promise.all(additions.map(autoSaveItem))
        setResultsByMode(old => ({ ...old, commerce: [...savedAdditions, ...old.commerce] }))
        addImageCharge(additions.length)
        updateCommerceRun(current => ({ ...current, progress: { ...current.progress, done: current.progress.done + 1 } }))
        return { success: true }
      } catch (error) {
        if (error.name === 'AbortError' || commercePauseRef.current) return { success: false, paused: true }
        return { success: false, error, retryable: isRetryableTimeout(error.message) }
      } finally {
        if (controller) commerceAbortRef.current.delete(controller)
      }
    }

    let retryQueue = []
    const initialEntries = pendingJobs.map((job, index) => ({ job, index }))
    await runWithConcurrency(initialEntries, generationConcurrency, async entry => {
      const result = await generateCommerceJob(entry)
      if (!result.success && !result.paused) {
        if (result.retryable) retryQueue.push(entry)
        else finalFailures.push({ ...entry, error: result.error })
      }
    })

    for (let round = 0; round < commerceFinalRetryDelays.length && retryQueue.length && !commercePauseRef.current; round++) {
      await wait(commerceFinalRetryDelays[round])
      const nextRetryQueue = []
      for (const entry of retryQueue) {
        if (commercePauseRef.current) break
        const result = await generateCommerceJob(entry)
        if (!result.success && !result.paused) {
          if (result.retryable && round < commerceFinalRetryDelays.length - 1) nextRetryQueue.push(entry)
          else finalFailures.push({ ...entry, error: result.error })
        }
      }
      retryQueue = nextRetryQueue
    }

    commerceAbortRef.current.clear()
    if (!commercePauseRef.current) {
      updateCommerceRun({
        running: false,
        error: finalFailures.length ? `本次有 ${finalFailures.length} 张图片暂未生成成功，其他图片已保留。可稍后点击“继续生成剩余图片”。` : '',
      })
    }
    window.setTimeout(() => document.querySelector('.gallery-section')?.scrollIntoView({ behavior: 'smooth' }), 150)
  }

  function pauseCommerceGeneration() {
    commercePauseRef.current = true
    commerceAbortRef.current.forEach(controller => controller.abort())
    commerceAbortRef.current.clear()
    updateCommerceRun({ running: false, error: '生成已暂停，已完成的图片会保留；再次点击“继续生成剩余图片”即可续传。' })
  }

  function removeSource(index) {
    setSources(old => {
      URL.revokeObjectURL(old[index].url)
      return old.filter((_, i) => i !== index)
    })
    setActiveSource(current => Math.max(0, current > index ? current - 1 : Math.min(current, sources.length - 2)))
  }

  function pauseTool(tool) {
    if (!toolRuns[tool]?.running) return
    toolPauseRefs.current[tool] = true
    toolAbortRefs.current[tool]?.abort()
    updateToolRun(tool, current => ({ ...current, running: false, paused: true, error: '' }))
  }

  async function run(runMode) {
    if (!['generate', 'edit'].includes(runMode) || toolRuns[runMode].running) return
    const previousRun = toolRuns[runMode]
    const resuming = previousRun.paused
    const runPrompt = prompts[runMode].trim()
    const savedOptions = toolOptions[runMode]
    const options = {
      ...savedOptions,
      count: normalizeToolGenerationCount(savedOptions.count),
      size: runMode === 'edit' ? normalizeEditSize(savedOptions.size) : normalizeStandardSize(savedOptions.size),
      quality: normalizeGenerationQuality(savedOptions.quality),
    }
    const completedBefore = resuming ? previousRun.progress.done : 0
    const targetTotal = resuming ? Math.max(completedBefore, options.count) : options.count
    if (!runPrompt) return setToolError(runMode, runMode === 'generate' ? '请输入画面描述' : '请输入图片编辑指令')
    if (!settingsConfigured) {
      if (isAdmin) openSettings()
      return setToolError(runMode, isAdmin ? '请先完成接口设置' : '管理员尚未完成接口设置，请联系管理员')
    }
    if (runMode === 'edit' && !sources.length) return setToolError('edit', '请先上传要编辑的图片')
    if (runMode === 'edit' && sourcePreparation.running) return setToolError('edit', '图片正在自动优化，请稍候再开始编辑')
    if (targetTotal <= completedBefore) {
      return updateToolRun(runMode, current => ({ ...current, paused: false, error: '', progress: { done: completedBefore, total: targetTotal } }))
    }

    const requestHeaders = { ...headers }
    const requestSettings = { model: settings.model, format: settings.format }
    const sourceSnapshot = runMode === 'edit'
      ? [sources[activeSource], ...sources.filter((_, index) => index !== activeSource)]
      : []
    let requestSize = options.size
    let requestPrompt = runPrompt
    if (runMode === 'edit') {
      try {
        let width
        let height
        let sourceFollowing = false
        let sourceRatioLimited = false
        let originalRatio = ''
        if (options.size === 'source') {
          const sourceSize = await readSourceDimensions(sourceSnapshot[0])
          const fittedSize = fitGptImage2OutputSize(sourceSize.width, sourceSize.height)
          width = fittedSize.width
          height = fittedSize.height
          sourceFollowing = true
          sourceRatioLimited = fittedSize.ratioLimited
          originalRatio = sizeRatio(sourceSize.width, sourceSize.height)
        } else if (options.size === 'custom') {
          width = Math.round(Number(options.customWidth))
          height = Math.round(Number(options.customHeight))
          if (!width || !height || width < 64 || height < 64 || width > 8192 || height > 8192) {
            throw new Error('自定义宽高需要填写 64–8192 之间的整数')
          }
        } else {
          [width, height] = options.size.split('x').map(Number)
        }
        if (!width || !height) throw new Error('无法确定输出画布尺寸')
        requestSize = `${width}x${height}`
        requestPrompt = `${runPrompt}\n\n【强制画布规格】${sourceFollowing
          ? `${sourceRatioLimited ? `原图比例 ${originalRatio} 超出模型限制，使用最接近的模型兼容比例` : `严格保持上传主图的原始宽高比 ${originalRatio}`}，按模型兼容尺寸 ${width}×${height} 像素输出`
          : `严格按所选规格 ${width}×${height} 像素生成`}，画布比例为 ${sizeRatio(width, height)}。不得改成其他比例，不得通过添加边框、留白或拼接画布规避该规格。`
      } catch (e) {
        return setToolError('edit', e.message)
      }
    }
    let maskSnapshot = null
    if (runMode === 'edit') {
      try { maskSnapshot = await maskEditorRef.current?.getMask() }
      catch (e) { return setToolError('edit', `无法读取编辑蒙版：${e.message}`) }
    }

    toolPauseRefs.current[runMode] = false
    updateToolRun(runMode, { running: true, paused: false, error: '', progress: { done: completedBefore, total: targetTotal } })
    for (let i = completedBefore; i < targetTotal; i++) {
      if (toolPauseRefs.current[runMode]) break
      const controller = new AbortController()
      toolAbortRefs.current[runMode] = controller
      let completed = false
      try {
        let response
        if (runMode === 'generate') {
          response = await fetch('/api/generate', {
            method: 'POST', signal: controller.signal,
            headers: { ...requestHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: requestSettings.model, prompt: runPrompt, n: 1, size: options.size, quality: options.quality, response_format: requestSettings.format }),
          })
        } else {
          const form = new FormData()
          sourceSnapshot.forEach(item => form.append('image', item.file))
          if (maskSnapshot) form.append('mask', maskSnapshot, 'mask.png')
          form.append('model', requestSettings.model)
          form.append('prompt', requestPrompt)
          form.append('n', '1')
          form.append('size', requestSize)
          form.append('quality', options.quality)
          form.append('response_format', requestSettings.format)
          response = await fetch('/api/edit', { method: 'POST', signal: controller.signal, headers: requestHeaders, body: form })
        }
        const data = await readJsonResponse(response)
        if (!response.ok) throw new Error(data?.error?.message || '生成失败')
        updateCurrentUser(data.user)
        const additions = (data.data || []).map((item, n) => ({
          id: `${runMode}-${Date.now()}-${i}-${n}`, src: getImage(item), prompt: runPrompt, mode: runMode, createdAt: new Date(),
        })).filter(x => x.src)
        if (!additions.length) throw new Error('接口没有返回可识别的图片数据')
        const savedAdditions = await Promise.all(additions.map(autoSaveItem))
        setResultsByMode(old => ({ ...old, [runMode]: [...savedAdditions, ...old[runMode]] }))
        addImageCharge(additions.length)
        const saveFailure = savedAdditions.find(item => item.saveError)
        if (saveFailure) setToolError(runMode, `图片已生成，但自动保存失败：${saveFailure.saveError}`)
        completed = true
      } catch (e) {
        if (e.name === 'AbortError' && toolPauseRefs.current[runMode]) break
        setToolError(runMode, `第 ${i + 1} 张失败：${friendlyError(e.message)}`)
        break
      } finally {
        if (toolAbortRefs.current[runMode] === controller) toolAbortRefs.current[runMode] = null
        if (completed) updateToolRun(runMode, current => ({ ...current, progress: { ...current.progress, done: current.progress.done + 1 } }))
      }
    }
    const paused = toolPauseRefs.current[runMode]
    updateToolRun(runMode, current => ({ ...current, running: false, paused }))
    if (!paused) toolPauseRefs.current[runMode] = false
  }

  async function download(item) {
    try {
      const blob = await fetch(item.src).then(r => r.blob())
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `image-${item.id}.png`; a.click()
      URL.revokeObjectURL(url)
    } catch { window.open(item.src, '_blank') }
  }

  function useForEdit(item) {
    fetch(item.src).then(r => r.blob()).then(blob => {
      const file = new File([blob], 'generated-image.png', { type: blob.type || 'image/png' })
      selectFiles([file]); setMode('edit'); window.scrollTo({ top: 0, behavior: 'smooth' })
    }).catch(() => setToolError('edit', '无法读取该图片用于编辑，请先下载后上传'))
  }

  const results = resultsByMode[mode] || []
  const isToolMode = mode === 'generate' || mode === 'edit'
  const activePrompt = isToolMode ? prompts[mode] : ''
  const activeOptions = isToolMode ? toolOptions[mode] : null
  const activeQuality = isToolMode ? normalizeGenerationQuality(activeOptions?.quality) : 'auto'
  const activeToolRun = isToolMode ? toolRuns[mode] : null
  const otherTool = mode === 'generate' ? 'edit' : 'generate'
  const otherToolRun = toolRuns[otherTool]
  const modeError = mode === 'commerce' ? commerceRun.error : activeToolRun?.error || ''

  function clearCurrentResults() {
    setResultsByMode(old => ({ ...old, [mode]: [] }))
  }

  const imagePointCost = Number(settings.imagePointCost ?? defaults.imagePointCost) || 0
  const copyPointCost = Number(settings.copyPointCost ?? defaults.copyPointCost) || 0
  const rechargeRate = Number(settings.rechargeRate ?? defaults.rechargeRate) || 0
  const checkInRewardPoints = Number(settings.checkInRewardPoints ?? defaults.checkInRewardPoints) || defaults.checkInRewardPoints
  const checkInWindowDays = Number(settings.checkInWindowDays ?? defaults.checkInWindowDays) || defaults.checkInWindowDays
  const paymentEnabled = settings.paymentEnabled === true
  const paymentMinAmount = Number(settings.paymentMinAmount ?? defaults.paymentMinAmount) || defaults.paymentMinAmount
  const membershipLevel = settings.membershipLevel || currentUser.membershipLevel || 'normal'
  const membershipLabel = settings.membershipLabel || (membershipLevel === 'svip' ? 'SVIP' : membershipLevel === 'vip' ? 'VIP' : '普通用户')
  const membershipTiers = settings.membershipTiers || {}
  const currentTier = membershipTiers[membershipLevel] || { imagePrice: Number(settings.normalImagePrice ?? defaults.normalImagePrice), copyPrice: Number(settings.normalCopyPrice ?? defaults.normalCopyPrice), imagePointCost, copyPointCost }
  const vipOpenPrice = Number(settings.vipOpenPrice ?? defaults.vipOpenPrice) || 0
  const svipOpenPrice = Number(settings.svipOpenPrice ?? defaults.svipOpenPrice) || 0
  const vipOrderAmount = vipOpenPrice
  const svipOrderAmount = membershipLevel === 'vip' ? Math.max(0, svipOpenPrice - vipOpenPrice) : svipOpenPrice
  const imageModelOptions = uniqueModelOptions(settings.model, defaults.model, modelCatalog.image)
  const copyModelOptions = uniqueModelOptions(settings.copyModel, defaults.copyModel, defaults.chatModel, modelCatalog.text)
  const chatModelOptions = uniqueModelOptions(settings.chatModel, defaults.chatModel, defaults.copyModel, modelCatalog.text)
  const checkInInfo = checkIn || currentUser.checkIn || null
  const checkInButtonText = checkInSaving
    ? '签到中…'
    : checkInInfo?.available
      ? `签到领取 ${formatPoints(checkInInfo.rewardPoints ?? checkInRewardPoints)} 分`
      : checkInInfo?.todayChecked
        ? '今日已签到'
        : checkInInfo?.expired
          ? '福利已结束'
          : '暂不可签到'

  return <div className="app-shell">
    <header>
      <div className="brand"><div className="brand-mark">造</div><div><b>造像所</b><small>AI IMAGE LAB</small></div></div>
      <div className="header-actions"><span className="local-status"><i />{isAdmin ? '管理员空间' : '用户空间'}</span><button className="ghost disclaimer-trigger" onClick={() => setDisclaimerOpen(true)}><Icon>§</Icon> 使用协议</button>{isAdmin ? <button className="ghost admin-center-trigger" onClick={() => setAdminCenterOpen(true)}><Icon>管</Icon> 管理设置</button> : <><button className="ghost billing-trigger" onClick={openBillingPanel}><Icon>◆</Icon> 积分 <small>{formatPoints(pointBalance)} 分</small></button><button className="ghost" onClick={openStorageSettings}><Icon>⚙</Icon> 图片保存位置</button></>}<button className="account-trigger" onClick={() => setAccountOpen(true)}><span>{currentUser.displayName.slice(0, 1).toUpperCase()}</span><b>{currentUser.displayName}</b><small>{isAdmin ? '管理员' : '普通用户'}</small></button></div>
    </header>

    <main>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">AI CREATIVE STUDIO · 2026</span>
          <h1>把脑海里的画面，<br/><em>变成作品。</em></h1>
          <p>从一句描述到完整视觉方案，在同一个工作台完成生成、编辑与电商素材创作。</p>
        <div className="hero-features"><span><i>01</i> 灵感描述</span><b>→</b><span><i>02</i> AI 创作</span><b>→</b><span><i>03</i> 工作台保存</span></div>
        </div>
        <div className="hero-art" aria-hidden="true"><span className="orb orb-one"/><span className="orb orb-two"/><div className="hero-art-card"><small>CREATIVE ENGINE</small><b>∞</b><span>想象力，没有边界</span></div></div>
      </section>

      <section className="workspace">
        <div className="tabs">
          <div className="tabs-label"><span>创作工具</span><small>独立任务，可并行运行</small></div>
          <button className={mode === 'generate' ? 'active' : ''} onClick={() => setMode('generate')}><Icon>✦</Icon><span>文字生图<small>从描述开始创作</small></span>{(toolRuns.generate.running || toolRuns.generate.paused) && <em className={'tool-status ' + (toolRuns.generate.paused ? 'paused' : '')}>{toolRuns.generate.paused ? '已暂停' : `${toolRuns.generate.progress.done}/${toolRuns.generate.progress.total}`}</em>}</button>
          <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon>◩</Icon><span>图片编辑<small>上传并精准修改</small></span>{(toolRuns.edit.running || toolRuns.edit.paused) && <em className={'tool-status ' + (toolRuns.edit.paused ? 'paused' : '')}>{toolRuns.edit.paused ? '已暂停' : `${toolRuns.edit.progress.done}/${toolRuns.edit.progress.total}`}</em>}</button>
          <button className={mode === 'commerce' ? 'active' : ''} onClick={() => setMode('commerce')}><Icon>◆</Icon><span>电商策划<small>批量生成整套素材</small></span>{commerceRun.running && <em className="tool-status">{commerceRun.progress.done}/{commerceRun.progress.total}</em>}</button>
          <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><Icon>●</Icon><span>AI 对话<small>和 GPT 连续聊天</small></span></button>
        </div>

        <div hidden={mode !== 'commerce'}>
          <EcommercePlanner headers={headers} settings={settings} configured={settingsConfigured} generating={commerceRun.running} progress={commerceRun.progress} onPause={pauseCommerceGeneration} onOpenSettings={isAdmin ? openSettings : null} onEditPrompt={openCommercePrompt} onGenerateSet={generateCommerceSet} onCopyGenerated={addCopyCharge} onUserUpdate={updateCurrentUser} />
        </div>

        {mode === 'chat' && <ChatPanel headers={headers} model={settings.chatModel || 'gpt-5.5'} configured={settingsConfigured} onOpenSettings={isAdmin ? openSettings : null} />}

        {isToolMode && <div className="parallel-workflow-note">
          <div><span><i />{mode === 'generate' ? '文字生图' : '图片编辑'}独立工作区</span><p>{activeToolRun.paused ? '任务已暂停，可以修改提示词、参数或图片后继续剩余任务。' : '提示词、参数和任务进度单独保存，切换工具不会中断当前任务。'}</p></div>
          {(otherToolRun.running || otherToolRun.paused) && <button onClick={() => setMode(otherTool)}>{otherTool === 'generate' ? '文字生图' : '图片编辑'}{otherToolRun.paused ? '已暂停' : '正在运行'} · {otherToolRun.progress.done}/{otherToolRun.progress.total}</button>}
        </div>}

        {mode === 'edit' && <div className="upload-row">
          {sources.length === 0 ? <label className={`dropzone${sourcePreparation.running ? ' is-processing' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); selectFiles(e.dataTransfer.files) }}>
            <input type="file" accept="image/*" multiple disabled={sourcePreparation.running} onChange={e => selectFiles(e.target.files)} />
            {sourcePreparation.running
              ? <><b className="processing-spinner">◌</b><span>正在自动优化图片</span><small>{sourcePreparation.done}/{sourcePreparation.total} · 降采样后再上传给 GPT</small></>
              : <><b>＋</b><span>点击或拖入图片</span><small>上传后自动降采样；第一张作为主图，其余作为参考图</small></>}
          </label> : <>
            <ImageMaskEditor ref={maskEditorRef} item={sources[activeSource]} />
            <div className={`source-strip${sourceDragActive ? ' is-dragging' : ''}`} onDragEnter={sourceDragEnter} onDragOver={sourceDragOver} onDragLeave={sourceDragLeave} onDrop={dropSourceFiles}>
              {sources.map((item, index) => <div className={'source-thumb ' + (index === activeSource ? 'active' : '')} key={item.id} title={index === activeSource ? `第 ${index + 1} 张：当前编辑主图` : `第 ${index + 1} 张：点击设为编辑主图`} onClick={() => setActiveSource(index)}>
                <img src={item.url} alt={`上传图片 ${index + 1}`} />
                <em className="source-index">{String(index + 1).padStart(2, '0')}</em>
                <span className="source-status">{index === activeSource ? '当前编辑主图' : '点击设为主图'}</span>
                <button title={`删除第 ${index + 1} 张图片`} onClick={e => { e.stopPropagation(); removeSource(index) }}>×</button>
              </div>)}
              {sources.length < 10 && <label className={`add-source${sourceDragActive ? ' is-dragging' : ''}${sourcePreparation.running ? ' is-processing' : ''}`}><input type="file" accept="image/*" multiple disabled={sourcePreparation.running} onChange={e => { selectFiles(e.target.files); e.target.value = '' }} /><b>{sourcePreparation.running ? '◌' : sourceDragActive ? '⇩' : '＋'}</b><span>{sourcePreparation.running ? `${sourcePreparation.done}/${sourcePreparation.total}` : sourceDragActive ? '松开添加' : '添加参考图'}</span></label>}
            </div>
            <p className="editor-tip"><b>紫色高亮并标有“当前编辑主图”的图片，是本次要修改的图片。</b> 左上角数字代表上传顺序；点击其他缩略图即可切换，提交时当前主图会自动排在第一张。</p>
            {(sourcePreparation.running || sourcePreparation.message) && <div className={`source-optimization-note${sourcePreparation.running ? ' is-processing' : ''}`}>{sourcePreparation.running ? `正在优化第 ${Math.min(sourcePreparation.done + 1, sourcePreparation.total)} / ${sourcePreparation.total} 张图片…` : sourcePreparation.message}</div>}
          </>}
        </div>}

        {mode !== 'commerce' && mode !== 'chat' && <div className="prompt-wrap">
          <textarea value={activePrompt} onChange={e => setPrompts(old => ({ ...old, [mode]: e.target.value }))} placeholder={mode === 'generate' ? '描述你想创造的画面，例如：雨后的东京街头，霓虹倒映在湿润路面，电影感摄影……' : '描述想如何修改，例如：把天空改成绚丽晚霞，保持人物和构图不变……'} />
          <span className="char-count">{activePrompt.length}</span>
        </div>}

        {mode !== 'commerce' && mode !== 'chat' && <div className="controls">
          <SizeSelector
            label="画面尺寸（宽 × 高）"
            value={activeOptions.size}
            options={mode === 'edit' ? EDIT_SIZE_OPTIONS : STANDARD_SIZE_OPTIONS}
            sourceSize={mode === 'edit' ? sources[activeSource] || null : null}
            onChange={e => updateToolOptions(mode, { size: e.target.value, ...(mode === 'edit' ? { sizeModeVersion: 1 } : {}) })}
          />
          <label><span>生成数量</span><select value={activeOptions.count} onChange={e => updateToolOptions(mode, { count: Number(e.target.value) })}>{toolGenerationCounts.map(n => <option key={n} value={n}>{n} 张（依次）</option>)}</select></label>
          <label className="quality-control"><span>{mode === 'edit' ? '编辑质量' : '生成质量'}</span><select value={activeQuality} onChange={e => updateToolOptions(mode, { quality: e.target.value })}>{generationQualityOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <div className="run-actions">
            <button className="create" disabled={activeToolRun.running || (mode === 'edit' && sourcePreparation.running)} onClick={() => run(mode)}>{mode === 'edit' && sourcePreparation.running ? <span className="ai-thinking"><i />正在优化图片 <small>{sourcePreparation.done}/{sourcePreparation.total}</small></span> : activeToolRun.running ? <span className="ai-thinking"><i />AI 正在思考中 <small>{activeToolRun.progress.done}/{activeToolRun.progress.total}</small></span> : activeToolRun.paused ? <><Icon>▶</Icon>继续任务 <small>{activeToolRun.progress.done}/{activeToolRun.progress.total}</small></> : <><Icon>✦</Icon>{mode === 'generate' ? '开始创造' : '开始编辑'}</>}</button>
            {activeToolRun.running && <button className="pause-task" onClick={() => pauseTool(mode)}><span>Ⅱ</span> 临时暂停</button>}
          </div>
        </div>}
        {error && <div className="error">{error}</div>}
        {modeError && <div className="error">{modeError}</div>}
      </section>

      {mode !== 'chat' && <section className="gallery-section">
        <div className="section-title"><div><span>YOUR CREATIONS</span><h2>{mode === 'generate' ? '文字生图记录' : mode === 'edit' ? '图片编辑记录' : '电商策划记录'}</h2></div>{results.length > 0 && <button className="text-btn" onClick={clearCurrentResults}>清空当前记录</button>}</div>
        {results.length === 0 ? <div className="empty"><div>◇</div><p>灵感正在等待发生</p><span>生成的作品会出现在这里</span></div> : <>
          {[['main', '商品主图'], ['sku', 'SKU 图'], ['detail', '商品详情图']].map(([category, title]) => {
            const items = results.filter(item => item.commerceCategory === category)
            if (!items.length) return null
            return <div className={`result-group ${category}`} key={category}><div className="result-group-title"><h3>{title}</h3><span>{items.length} 张</span></div><div className="gallery">{items.map(item => <article key={item.id}>
              <img src={item.src} alt={item.prompt} style={item.commerceSize ? { aspectRatio: item.commerceSize.replace('x', ' / ') } : undefined} />
              <div className="card-info"><b>{item.commerceLabel}</b>{category !== 'sku' && <p>{item.prompt}</p>}{item.savedPath && <small className="saved-mark">✓ 已保存</small>}{item.saveError && <small className="save-failed">保存失败</small>}<div><button onClick={() => useForEdit(item)}>编辑</button><button onClick={() => download(item)}>下载 ↓</button></div></div>
            </article>)}</div></div>
          })}
          {results.some(item => !item.commerceCategory) && <div className="result-group"><div className="result-group-title"><h3>{mode === 'edit' ? '图片编辑' : '文字生图'}</h3><span>{results.filter(item => !item.commerceCategory).length} 张</span></div><div className="gallery">{results.filter(item => !item.commerceCategory).map(item => <article key={item.id}>
            <img src={item.src} alt={item.prompt} /><div className="card-info"><p>{item.prompt}</p>{item.savedPath && <small className="saved-mark">✓ 已保存</small>}{item.saveError && <small className="save-failed">保存失败</small>}<div><button onClick={() => useForEdit(item)}>编辑</button><button onClick={() => download(item)}>下载 ↓</button></div></div>
          </article>)}</div></div>}
        </>}
      </section>}
    </main>

    {billingOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && closeBillingPanel()}><div className={`modal billing-modal${isAdmin ? '' : ' user-billing-modal'}`}>
      <div className="modal-head"><div><span>POINTS</span><h2>{isAdmin ? '积分会员' : '我的积分'}</h2></div><button onClick={closeBillingPanel}>×</button></div>
      {isAdmin ? <>
      <div className="points-balance-card"><span>当前余额</span><b>{formatPoints(pointBalance)} 分</b><small>图片与文案生成会按规则自动扣除积分</small></div>
      <div className="billing-notice"><b>管理员可修改会员扣费规则</b><p>按人民币单价设置，系统会根据充值比例自动换算为扣除积分。</p></div>
      <div className="membership-admin-settings">
        <label><span>充值比例（每 1 元获得积分）</span><input type="number" min="0" step="0.01" disabled={billingSaving} value={rechargeRate} onChange={e => setSettings(old => ({ ...old, rechargeRate: Math.max(0, Number(e.target.value) || 0) }))} /></label>
        <div className="membership-tier-settings checkin-admin-settings">
          <div><b>新用户签到</b><small>普通用户端只展示，规则由管理员设置</small></div>
          <label><span>签到有效天数</span><input type="number" min="1" max="3650" step="1" disabled={billingSaving} value={checkInWindowDays} onChange={e => setSettings(old => ({ ...old, checkInWindowDays: Math.max(1, Math.floor(Number(e.target.value) || defaults.checkInWindowDays)) }))} /></label>
          <label><span>每次赠送积分</span><input type="number" min="0.01" step="0.01" disabled={billingSaving} value={checkInRewardPoints} onChange={e => setSettings(old => ({ ...old, checkInRewardPoints: Math.max(0.01, Number(e.target.value) || defaults.checkInRewardPoints) }))} /></label>
          <div><b>{formatPoints(checkInWindowDays * checkInRewardPoints)} 分</b><small>每个新用户最多可领取</small></div>
        </div>
        {[
          ['normal', '普通用户', 'normalImagePrice', 'normalCopyPrice', ''],
          ['vip', 'VIP', 'vipImagePrice', 'vipCopyPrice', 'vipOpenPrice'],
          ['svip', 'SVIP', 'svipImagePrice', 'svipCopyPrice', 'svipOpenPrice'],
        ].map(([, label, imageKey, copyKey, openKey]) => <div className="membership-tier-settings" key={label}>
          <div><b>{label}</b><small>{openKey ? `开通费：${Number(settings[openKey] ?? defaults[openKey] ?? 0).toFixed(2)} 元` : '默认等级，无开通费'}</small></div>
          <label><span>图片单价（元/张）</span><input type="number" min="0" step="0.01" disabled={billingSaving} value={Number(settings[imageKey] ?? defaults[imageKey]) || 0} onChange={e => setSettings(old => ({ ...old, [imageKey]: Math.max(0, Number(e.target.value) || 0) }))} /></label>
          <label><span>文案单价（元/次）</span><input type="number" min="0" step="0.01" disabled={billingSaving} value={Number(settings[copyKey] ?? defaults[copyKey]) || 0} onChange={e => setSettings(old => ({ ...old, [copyKey]: Math.max(0, Number(e.target.value) || 0) }))} /></label>
          {openKey && <label><span>{label} 开通费（元）</span><input type="number" min="0" step="0.01" disabled={billingSaving} value={Number(settings[openKey] ?? defaults[openKey]) || 0} onChange={e => setSettings(old => ({ ...old, [openKey]: Math.max(0, Number(e.target.value) || 0) }))} /></label>}
          {openKey && <label className="membership-description-field"><span>{label} 权益说明</span><textarea disabled={billingSaving} value={settings[label.toLowerCase() + 'Description'] || ''} onChange={e => setSettings(old => ({ ...old, [label.toLowerCase() + 'Description']: e.target.value }))} placeholder={`介绍${label}会员权益，普通用户端可见`} /></label>}
        </div>)}
      </div>
      {billingMessage && <div className={`account-message${billingMessage.ok ? ' success' : ''}`}>{billingMessage.text}</div>}
      <p className="privacy">积分余额保存在服务端账户中；图片和文案生成成功后会按上方规则自动扣除。</p>
      <div className="billing-actions"><button className="save" disabled={billingSaving} onClick={savePointSettings}>{billingSaving ? '保存中…' : '保存积分规则'}</button></div>
      </> : <>
      <div className="user-points-hero">
        <div><span>当前余额</span><b>{formatPoints(pointBalance)} 分</b><small>充值后自动增加积分，生成成功才会扣除。</small></div>
        <button type="button" onClick={() => refreshWallet().catch(error => setBillingMessage({ ok: false, text: error.message }))}>刷新余额</button>
      </div>
      {checkInInfo?.enabled && <div className={`checkin-card${checkInInfo.available ? ' available' : ''}${checkInInfo.todayChecked ? ' done' : ''}${checkInInfo.expired ? ' expired' : ''}`}>
        <div>
          <span>NEW USER BONUS</span>
          <b>每日签到送积分</b>
          <small>{checkInInfo.expired ? '注册福利期已结束' : `注册起 ${checkInInfo.totalDays || checkInWindowDays} 天内有效 · 当前第 ${checkInInfo.dayIndex || 0} 天`}</small>
        </div>
        <div className="checkin-progress">
          <em>{checkInInfo.checkedDays || 0}/{checkInInfo.totalDays || checkInWindowDays}</em>
          <small>{checkInInfo.todayChecked ? '今天已领取' : checkInInfo.available ? `今天可领取 ${formatPoints(checkInInfo.rewardPoints ?? checkInRewardPoints)} 分` : checkInInfo.expired ? '已结束' : '暂不可领取'}</small>
        </div>
        <button type="button" disabled={checkInSaving || !checkInInfo.available} onClick={checkInToday}>{checkInButtonText}</button>
      </div>}
      <div className="user-cost-grid">
        <div><span>当前等级</span><b>{membershipLabel}</b><small>按当前等级自动扣费</small></div>
        <div><span>图片生成</span><b>{formatPoints(currentTier.imagePointCost)} 分</b><small>{Number(currentTier.imagePrice || 0).toFixed(2)} 元/张</small></div>
        <div><span>文案生成</span><b>{formatPoints(currentTier.copyPointCost)} 分</b><small>{Number(currentTier.copyPrice || 0).toFixed(2)} 元/次</small></div>
      </div>
      <section className="user-billing-section">
        <div className="user-section-head"><div><span>MEMBERSHIP</span><b>会员权益</b></div><small>支付会员费后自动升级，后续按对应等级扣费。</small></div>
        <div className="membership-benefits">
          {membershipLevel !== 'svip' && <article><b>VIP</b><p>{settings.vipDescription || defaults.vipDescription}</p><small>图片 {Number(settings.vipImagePrice ?? defaults.vipImagePrice).toFixed(2)} 元/张 · 文案 {Number(settings.vipCopyPrice ?? defaults.vipCopyPrice).toFixed(2)} 元/次</small></article>}
          <article><b>SVIP</b><p>{settings.svipDescription || defaults.svipDescription}</p><small>图片 {Number(settings.svipImagePrice ?? defaults.svipImagePrice).toFixed(2)} 元/张 · 文案 {Number(settings.svipCopyPrice ?? defaults.svipCopyPrice).toFixed(2)} 元/次</small></article>
        </div>
        <div className="membership-upgrades">
          {membershipLevel === 'normal' && <button type="button" disabled={membershipSaving === 'vip' || !paymentEnabled || !settings.paymentConfigured} onClick={() => buyMembership('vip')}>{membershipSaving === 'vip' ? '创建中…' : `开通 VIP · ${vipOrderAmount.toFixed(2)} 元`}</button>}
          {membershipLevel !== 'svip' && <button type="button" disabled={membershipSaving === 'svip' || !paymentEnabled || !settings.paymentConfigured || svipOrderAmount <= 0} onClick={() => buyMembership('svip')}>{membershipSaving === 'svip' ? '创建中…' : membershipLevel === 'vip' ? `升级 SVIP · 补差价 ${svipOrderAmount.toFixed(2)} 元` : `开通 SVIP · ${svipOrderAmount.toFixed(2)} 元`}</button>}
        </div>
      </section>
      {billingMessage && <div className={`account-message${billingMessage.ok ? ' success' : ''}`}>{billingMessage.text}</div>}
      <section className="user-billing-section recharge-section">
        <div className="user-section-head"><div><span>RECHARGE</span><b>积分充值</b></div><small>比例由管理员设置：1 元 = {formatPoints(rechargeRate)} 分</small></div>
        <form className="recharge-form" onSubmit={rechargePoints}>
          <label><span>充值金额（元）</span><input type="number" min={paymentMinAmount} step="0.01" value={rechargeAmount} onChange={event => setRechargeAmount(event.target.value)} placeholder={`最低 ${paymentMinAmount} 元`} /></label>
          <button className="save" disabled={rechargeSaving || rechargeRate <= 0 || !paymentEnabled || !settings.paymentConfigured}>{rechargeSaving ? '创建订单中…' : `支付宝充值 ${formatPoints((Number(rechargeAmount) || 0) * rechargeRate)} 分`}</button>
        </form>
        {(!paymentEnabled || !settings.paymentConfigured) && <p className="payment-disabled-tip">在线充值尚未启用，请联系管理员配置易支付参数。</p>}
      </section>
      {rechargeOrders.length > 0 && <div className="recharge-orders">
        <div className="recharge-orders-head"><button type="button" className="recharge-orders-toggle" onClick={() => setRechargeOrdersExpanded(value => !value)}><b>最近订单</b><small>{rechargeOrders.length} 条记录 · {rechargeOrdersExpanded ? '点击收起' : '点击展开'}</small></button><div><button type="button" onClick={() => setRechargeOrdersExpanded(value => !value)}>{rechargeOrdersExpanded ? '收起' : '展开'}</button><button type="button" onClick={() => refreshWallet().catch(error => setBillingMessage({ ok: false, text: error.message }))}>刷新</button></div></div>
        {rechargeOrdersExpanded && rechargeOrders.slice(0, 5).map(order => <div className="recharge-order" key={order.id}><span><b>{order.status === 'success' ? order.kind === 'membership' ? '已升级' : '已到账' : order.status === 'pending' ? '待支付' : order.status === 'canceled' ? '已取消' : '失败'}</b><small>{order.tradeNo}</small></span><em>{order.kind === 'membership' ? `${order.membershipFromLevel === 'vip' && order.membershipLevel === 'svip' ? 'VIP 升级 ' : ''}${order.membershipLevel === 'svip' ? 'SVIP' : 'VIP'} 会员` : `${formatPoints(order.points)} 分`}</em><i>{Number(order.amount || 0).toFixed(2)} 元</i>{order.status === 'pending' && <button type="button" className="cancel-order" onClick={() => cancelOrder(order)}>取消</button>}</div>)}
      </div>}
      <p className="privacy">积分余额保存在服务端账户中；图片和文案生成成功后会按上方规则自动扣除。</p>
      </>}
    </div></div>}

    {isAdmin && adminCenterOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setAdminCenterOpen(false)}><div className="modal admin-center-modal">
      <div className="modal-head"><div><span>ADMIN CENTER</span><h2>管理设置</h2></div><button onClick={() => setAdminCenterOpen(false)}>×</button></div>
      <div className="admin-center-grid">
        <button type="button" onClick={() => openAdminCenterSection('billing')}><Icon>◆</Icon><span><b>积分会员</b><small>充值比例、会员价格、VIP/SVIP说明</small></span></button>
        <button type="button" onClick={() => openAdminCenterSection('payment')}><Icon>￥</Icon><span><b>支付管理</b><small>易支付网关、回调地址、商户 ID、商户密钥和最低充值金额</small></span></button>
        <button type="button" onClick={() => openAdminCenterSection('users')}><Icon>♙</Icon><span><b>用户管理</b><small>创建用户、积分余额、备注、重置密码和停用账户</small></span></button>
        <button type="button" onClick={() => openAdminCenterSection('orders')}><Icon>◎</Icon><span><b>订单管理</b><small>查看充值/会员订单，处理待支付或补单问题</small></span></button>
        <button type="button" onClick={() => openAdminCenterSection('settings')}><Icon>⚙</Icon><span><b>接口设置</b><small>NewAPI、模型、保存和系统更新</small></span></button>
      </div>
      <p className="privacy">常用管理功能已统一收纳到这里，顶部只保留一个管理员入口。</p>
    </div></div>}

    {isAdmin && paymentOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && closePaymentPanel()}><div className="modal payment-modal">
      <div className="modal-head"><div><span>PAYMENT SETTINGS</span><h2>支付管理</h2></div><button onClick={closePaymentPanel}>×</button></div>
      <div className="payment-settings standalone">
        <div className="payment-settings-head"><div><span>ONLINE PAYMENT</span><b>易支付充值接口</b><small>回调地址：/api/payment/epay/notify。保存前请确认回调根地址可被支付平台公网访问。</small></div><label className="autosave-toggle"><input type="checkbox" checked={paymentEnabled} onChange={event => setSettings(old => ({ ...old, paymentEnabled: event.target.checked }))} /><span>{paymentEnabled ? '已启用在线充值' : '未启用在线充值'}</span></label></div>
        <div className="payment-settings-grid">
          <label><span>易支付网关地址</span><input disabled={paymentSaving} value={settings.paymentGatewayUrl || ''} onChange={e => setSettings(old => ({ ...old, paymentGatewayUrl: e.target.value }))} placeholder="https://pay.example.com" /></label>
          <label><span>回调根地址</span><input disabled={paymentSaving} value={settings.paymentCallbackBaseUrl || ''} onChange={e => setSettings(old => ({ ...old, paymentCallbackBaseUrl: e.target.value }))} placeholder="https://你的域名" /></label>
          <label><span>支付完成返回地址（可选）</span><input disabled={paymentSaving} value={settings.paymentReturnUrl || ''} onChange={e => setSettings(old => ({ ...old, paymentReturnUrl: e.target.value }))} placeholder="留空则返回回调根地址" /></label>
          <label><span>商户 ID</span><input disabled={paymentSaving} value={settings.paymentMerchantId || ''} onChange={e => setSettings(old => ({ ...old, paymentMerchantId: e.target.value }))} placeholder="pid" /></label>
          <label><span>商户密钥</span><input type="password" disabled={paymentSaving} value={settings.paymentMerchantKey || ''} onChange={e => setSettings(old => ({ ...old, paymentMerchantKey: e.target.value }))} placeholder={settings.hasPaymentMerchantKey ? `已配置 ${settings.paymentMerchantKeyHint || ''}，留空不修改` : 'merchant key'} /></label>
          <label><span>最低充值金额（元）</span><input type="number" min="0.01" step="0.01" disabled={paymentSaving} value={paymentMinAmount} onChange={e => setSettings(old => ({ ...old, paymentMinAmount: Math.max(0.01, Number(e.target.value) || defaults.paymentMinAmount) }))} /></label>
        </div>
      </div>
      {paymentMessage && <div className={`account-message${paymentMessage.ok ? ' success' : ''}`}>{paymentMessage.text}</div>}
      <p className="privacy">支付配置只在管理员端维护，普通用户只能看到是否可充值，不会看到商户密钥。</p>
      <div className="billing-actions"><button className="save" disabled={paymentSaving} onClick={savePaymentSettings}>{paymentSaving ? '保存中…' : '保存支付配置'}</button></div>
    </div></div>}

    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && closeSettings()}><div className="modal">
      <div className="modal-head"><div><span>{isAdmin ? 'ADMIN CONNECTION' : 'LOCAL STORAGE'}</span><h2>{isAdmin ? '接口设置' : '图片保存位置'}</h2></div><button onClick={closeSettings}>×</button></div>
      {isAdmin && <>
        <div className="admin-only-notice"><b>仅管理员可修改</b><p>配置保存在本机服务端，普通用户无法查看 API Key 或访问此页面。</p></div>
        <label><span>NewAPI Base URL</span><input value={settings.baseUrl} onChange={e => { setSettings(s => ({ ...s, baseUrl: e.target.value })); setModelCatalog({ image: [], text: [] }); setTestResult(null) }} placeholder={defaults.baseUrl} /></label>
        <label><span>API Key</span><input type="password" value={settings.apiKey} onChange={e => { setSettings(s => ({ ...s, apiKey: e.target.value })); setModelCatalog({ image: [], text: [] }); setTestResult(null) }} placeholder={settings.hasApiKey ? `已配置 ${settings.apiKeyHint || ''}，留空表示不修改` : 'sk-...'} /></label>
        <label><span>图片模型</span><select value={settings.model} onChange={e => { setSettings(s => ({ ...s, model: e.target.value })); setTestResult(null) }}>{imageModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>文案分析模型</span><select value={settings.copyModel || defaults.copyModel} onChange={e => { setSettings(s => ({ ...s, copyModel: e.target.value })); setTestResult(null) }}>{copyModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>AI 对话模型</span><select value={settings.chatModel || defaults.chatModel} onChange={e => { setSettings(s => ({ ...s, chatModel: e.target.value })); setTestResult(null) }}>{chatModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>返回格式</span><select value={settings.format} onChange={e => setSettings(s => ({ ...s, format: e.target.value }))}><option value="url">URL</option><option value="b64_json">Base64（更适合本地）</option></select></label>
      </>}
      <div className="storage-settings">
        <div><span>数据保存</span><b>生成图片自动保存到工作台</b></div>
        <label className="autosave-toggle"><input type="checkbox" checked={Boolean(settings.autoSave)} onChange={e => setSettings(s => ({ ...s, autoSave: e.target.checked }))} /><span>{settings.autoSave ? '已开启自动保存' : '未开启自动保存'}</span></label>
        <div className="directory-picker"><input value={settings.saveDirectory || ''} onChange={e => { setBrowserSaveDirectory(null); browserSaveDirectoryRef.current = null; setSettings(s => ({ ...s, saveDirectory: e.target.value })) }} placeholder="例如：D:\\电商图片" /><button type="button" onClick={chooseSaveDirectory}>{selectingDirectory ? '正在选择…' : '选择文件夹'}</button></div>
        <small>{browserSaveDirectory ? '已授权当前浏览器写入所选文件夹；刷新页面后如果自动保存失败，请重新选择文件夹。' : '点击“选择文件夹”可打开本机目录选择器。系统会按文字生图、图片编辑、商品主图、SKU图和商品详情图分别创建子文件夹。'}</small>
      </div>
      {isAdmin && <div className="system-update-panel">
        <div className="system-update-head"><div><span>SYSTEM UPDATE</span><b>从 GitHub 自动更新</b><small>部署到云服务器后，可检查远程仓库更新并自动执行 git pull、npm install、npm run build，然后重启本站服务。</small></div><div><button type="button" onClick={checkSystemUpdate} disabled={updateChecking || updateRunning}>{updateChecking ? '检查中…' : '检查更新'}</button><button type="button" className="save" onClick={runSystemUpdate} disabled={updateChecking || updateRunning || !updateResult?.hasUpdate}>{updateRunning ? '更新中…' : '执行更新'}</button></div></div>
        {updateResult && <div className={`system-update-result${updateResult.ok ? ' success' : ' warning'}`}>
          <b>{updateResult.message || (updateResult.ok ? '检查完成' : '检查失败')}</b>
          {(updateResult.branch || updateResult.current || updateResult.remoteHead) && <p>分支：{updateResult.branch || '-'} · 当前：{updateResult.current || '-'} · 远程：{updateResult.remoteHead || '-'}</p>}
          {updateResult.restartScheduled && <p>已安排自动重启 {updateResult.restartService ? `${updateResult.restartService}.service` : '本站服务'}，稍等几秒后刷新页面即可。</p>}
          {updateResult.needsRestart && !updateResult.restartScheduled && <p>提示：如果后端代码有变化，请在云服务器重启 Node/PM2/systemd 服务后生效。</p>}
          {Array.isArray(updateResult.steps) && updateResult.steps.length > 0 && <details><summary>查看更新日志</summary><pre>{updateResult.steps.map(step => `$ ${step.command}\n${step.output || ''}`).join('\n\n')}</pre></details>}
        </div>}
      </div>}
      {testResult && <div className={'test-result ' + (testResult.ok && testResult.modelAvailable !== false && testResult.copyModelAvailable !== false && testResult.chatModelAvailable !== false ? 'success' : 'warning')}>
        <b>{testResult.title || (testResult.ok ? (testResult.modelAvailable === false || testResult.copyModelAvailable === false || testResult.chatModelAvailable === false ? '部分模型不可用' : '测试通过') : '测试失败')}</b>
        <p>{testResult.message}</p>
        {isAdmin && testResult.latency !== undefined && <small>响应时间：{testResult.latency} ms · 接口返回 {testResult.modelsCount} 个模型</small>}
        {isAdmin && testResult.ok && <div className="model-catalog-note">已加载 {modelCatalog.image.length} 个图片模型、{modelCatalog.text.length} 个文本模型，可在上方下拉框中选择。</div>}
      </div>}
      {isAdmin && <p className="privacy">API Key 不会返回给浏览器；普通用户的生成请求由本机服务使用已保存的接口配置转发。</p>}
      <div className={`modal-actions${isAdmin ? '' : ' single'}`}>{isAdmin && <button className="test-button" disabled={testing || settingsSaving} onClick={testConnection}>{testing ? <span className="ai-thinking"><i />正在连接接口</span> : '测试接口'}</button>}<button className="save" disabled={settingsSaving} onClick={isAdmin ? saveSettings : saveStorageSettings}>{settingsSaving ? '保存中…' : isAdmin ? '保存设置' : '保存图片位置'}</button></div>
    </div></div>}

    {accountOpen && <AccountModal user={currentUser} onClose={() => setAccountOpen(false)} onLogout={onLogout} />}
    {isAdmin && usersOpen && <UserManagementModal onClose={closeUsersPanel} />}
    {isAdmin && ordersOpen && <OrderManagementModal onClose={closeOrdersPanel} />}
    {disclaimerOpen && <DisclaimerModal required={!disclaimerAccepted} onAccept={acceptDisclaimer} onClose={() => setDisclaimerOpen(false)} />}
  </div>
}

function Root() {
  const [authState, setAuthState] = useState({ loading: true, needsSetup: false, user: null, error: '' })

  useEffect(() => {
    fetch('/api/auth/status')
      .then(readJsonResponse)
      .then(data => setAuthState({ loading: false, needsSetup: Boolean(data.needsSetup), user: data.user || null, error: '' }))
      .catch(error => setAuthState({ loading: false, needsSetup: false, user: null, error: error.message }))
  }, [])

  if (authState.loading) return <div className="auth-loading"><div className="brand-mark">造</div><span>正在打开工作台…</span></div>
  if (!authState.user) return <AuthScreen needsSetup={authState.needsSetup} onAuthenticated={user => setAuthState({ loading: false, needsSetup: false, user, error: '' })} />
  return <App key={authState.user.id} currentUser={authState.user} onLogout={() => setAuthState({ loading: false, needsSetup: false, user: null, error: '' })} />
}

const rootElement = document.getElementById('root')
const appRoot = globalThis.__imageStudioRoot || createRoot(rootElement)
globalThis.__imageStudioRoot = appRoot
appRoot.render(<Root />)
